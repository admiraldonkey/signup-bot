import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  foreignKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
/*
 * Fixed system states.
 *
 * Event types themselves, such as naval or linebattle, are database records
 * rather than enums so admins can add new ones without changing the code.
 */

export const eventStatusEnum = pgEnum("event_status", [
  "scheduled",
  "open",
  "closed",
  "cancelled",
  "completed",
]);

export const attendanceStatusEnum = pgEnum("attendance_status", [
  "attending",
  "tentative",
  "not_attending",
]);

export const eventMessageKindEnum = pgEnum("event_message_kind", [
  "attendance",
  "role_request",
  "reminder",
  "admin_summary",
  "organiser_cover",
  "organiser_missing_at_start",
]);

export const scheduledActionStatusEnum = pgEnum("scheduled_action_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const organiserSlotEnum = pgEnum("organiser_slot", [
  "primary",
  "backup",
  "cover",
]);

export const organiserStatusEnum = pgEnum("organiser_status", [
  "pending",
  "confirmed",
  "declined",
  "timed_out",
  "replaced",
  "removed",
]);

/*
 * Discord servers where the bot is installed and configured.
 */

export const discordGuilds = pgTable("discord_guilds", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

  // Discord snowflakes must be stored as text, not JavaScript numbers.
  discordGuildId: text("discord_guild_id").notNull().unique(),

  name: varchar("name", { length: 100 }).notNull(),

  timezone: varchar("timezone", { length: 64 })
    .notNull()
    .default("Europe/London"),

  enabled: boolean("enabled").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/*
 * Server-specific channels and roles.
 */

export const guildSettings = pgTable("guild_settings", {
  guildId: integer("guild_id")
    .notNull()
    .references(() => discordGuilds.id, { onDelete: "cascade" })
    .primaryKey(),

  eventAdminRoleId: text("event_admin_role_id"),

  eventOrganiserRoleId: text("event_organiser_role_id"),

  organisersEnabled: boolean("organisers_enabled").notNull().default(true),

  organiserDmsEnabled: boolean("organiser_dms_enabled").notNull().default(true),

  organiserPrimaryResponseMinutes: integer("organiser_primary_response_minutes")
    .notNull()
    .default(70),

  organiserBackupResponseMinutes: integer("organiser_backup_response_minutes")
    .notNull()
    .default(35),

  organiserCoverBeforeStartMinutes: integer(
    "organiser_cover_before_start_minutes",
  )
    .notNull()
    .default(15),

  organiserWarningMinutesBefore: integer("organiser_warning_minutes_before")
    .notNull()
    .default(15),

  defaultAttendanceChannelId: text("default_attendance_channel_id"),

  eventAdminChannelId: text("event_admin_channel_id"),

  defaultRoleRequestChannelId: text("default_role_request_channel_id"),

  botLogChannelId: text("bot_log_channel_id"),

  defaultPingRoleId: text("default_ping_role_id"),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/*
 * Configurable event categories, for example naval, linebattle or competition.
 */

export const eventTypes = pgTable(
  "event_types",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    ownerGuildId: integer("owner_guild_id")
      .notNull()
      .references(() => discordGuilds.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 64 }).notNull(),

    name: varchar("name", { length: 100 }).notNull(),

    description: text("description"),

    roleRequestsEnabled: boolean("role_requests_enabled")
      .notNull()
      .default(true),

    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("event_types_owner_code_unique").on(
      table.ownerGuildId,
      table.code,
    ),
    index("event_types_owner_guild_idx").on(table.ownerGuildId),
  ],
);

export const eventAudiences = pgTable(
  "event_audiences",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    ownerGuildId: integer("owner_guild_id")
      .notNull()
      .references(() => discordGuilds.id, {
        onDelete: "cascade",
      }),

    code: varchar("code", {
      length: 32,
    }).notNull(),

    name: varchar("name", {
      length: 100,
    }).notNull(),

    defaultTimezone: varchar("default_timezone", {
      length: 64,
    }).notNull(),

    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("event_audiences_owner_code_unique").on(
      table.ownerGuildId,
      table.code,
    ),

    index("event_audiences_owner_guild_idx").on(table.ownerGuildId),
  ],
);

/*
 * Reusable guild-level role-request configurations.
 *
 * A preset describes the logical roles and request groups commonly reused
 * across events, for example "Naval" or "Linebattle".
 *
 * Applying a preset snapshots its configuration into an actual event.
 * Existing events therefore remain independent of later preset edits.
 */

export const roleRequestPresets = pgTable(
  "role_request_presets",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    ownerGuildId: integer("owner_guild_id")
      .notNull()
      .references(() => discordGuilds.id, {
        onDelete: "cascade",
      }),

    name: varchar("name", {
      length: 100,
    }).notNull(),

    description: text("description"),

    active: boolean("active").notNull().default(true),

    createdByUserId: text("created_by_user_id").notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("role_request_presets_owner_name_unique").on(
      table.ownerGuildId,
      table.name,
    ),

    index("role_request_presets_owner_guild_idx").on(table.ownerGuildId),
  ],
);

/*
 * Logical requestable roles belonging to a reusable preset.
 *
 * These mirror event_role_options closely because application is intended to
 * be a straightforward snapshot rather than an interpretation layer.
 */
export const roleRequestPresetOptions = pgTable(
  "role_request_preset_options",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    presetId: integer("preset_id")
      .notNull()
      .references(() => roleRequestPresets.id, {
        onDelete: "cascade",
      }),

    key: varchar("key", {
      length: 64,
    }).notNull(),

    displayName: varchar("display_name", {
      length: 100,
    }).notNull(),

    description: text("description"),

    /*
     * Supported by the application:
     * - open
     * - qualified_only
     */
    requestRestriction: varchar("request_restriction", {
      length: 32,
    })
      .notNull()
      .default("open"),

    capacity: integer("capacity"),

    sortOrder: integer("sort_order").notNull().default(0),

    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("role_request_preset_options_preset_key_unique").on(
      table.presetId,
      table.key,
    ),

    index("role_request_preset_options_preset_idx").on(table.presetId),
  ],
);

/*
 * Discord roles which indicate qualification for a reusable preset option.
 *
 * These are copied to event_role_option_qualification_roles when the preset
 * is applied to an event.
 */
export const roleRequestPresetOptionQualificationRoles = pgTable(
  "role_request_preset_option_qualification_roles",
  {
    presetOptionId: integer("preset_option_id")
      .notNull()
      .references(() => roleRequestPresetOptions.id, {
        onDelete: "cascade",
      }),

    discordRoleId: text("discord_role_id").notNull(),

    roleNameSnapshot: varchar("role_name_snapshot", {
      length: 100,
    }).notNull(),

    /*
     * Currently supported:
     * - qualified
     * - supervision_required
     */
    qualificationLevel: varchar("qualification_level", {
      length: 32,
    }).notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "role_request_preset_option_qual_roles_pk",

      columns: [table.presetOptionId, table.discordRoleId],
    }),

    index("role_request_preset_option_qualification_idx").on(
      table.presetOptionId,
    ),
  ],
);

/*
 * One reusable Discord-facing request-group definition.
 *
 * channelId is nullable deliberately. Null means "resolve the guild's current
 * default role-request channel when this preset is applied".
 *
 * Once applied, the resolved channel is snapshotted into role_request_groups.
 */
export const roleRequestPresetGroups = pgTable(
  "role_request_preset_groups",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    presetId: integer("preset_id")
      .notNull()
      .references(() => roleRequestPresets.id, {
        onDelete: "cascade",
      }),

    name: varchar("name", {
      length: 100,
    }).notNull(),

    description: text("description"),

    channelId: text("channel_id"),

    notifyRoleId: text("notify_role_id"),

    notifyRoleNameSnapshot: varchar("notify_role_name_snapshot", {
      length: 100,
    }),

    requiresPositiveSignup: boolean("requires_positive_signup")
      .notNull()
      .default(false),

    /*
     * Signed offsets relative to event start.
     *
     *  60 = 60 minutes before start
     *   0 = at event start
     * -10 = 10 minutes after start
     */
    openMinutesBeforeStart: integer("open_minutes_before_start")
      .notNull()
      .default(60),

    closeMinutesBeforeStart: integer("close_minutes_before_start")
      .notNull()
      .default(0),

    sortOrder: integer("sort_order").notNull().default(0),

    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("role_request_preset_groups_preset_idx").on(table.presetId),
  ],
);

/*
 * Ordered Discord roles pinged when a reusable preset request group opens.
 *
 * The collection is snapshotted into role_request_group_notification_roles
 * when the preset is applied to an event.
 *
 * The application currently limits this collection to four roles. The
 * database intentionally models a general collection so changing that limit
 * later does not require another schema redesign.
 */
export const roleRequestPresetGroupNotificationRoles = pgTable(
  "role_request_preset_group_notification_roles",
  {
    presetGroupId: integer("preset_group_id").notNull(),

    discordRoleId: text("discord_role_id").notNull(),

    /*
     * Nullable for migration compatibility with any historical row whose
     * legacy role ID exists without a corresponding name snapshot.
     *
     * Normal service writes should always provide a name snapshot.
     */
    roleNameSnapshot: varchar("role_name_snapshot", {
      length: 100,
    }),

    sortOrder: integer("sort_order").notNull().default(0),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "role_request_preset_group_notification_roles_pk",

      columns: [table.presetGroupId, table.discordRoleId],
    }),

    foreignKey({
      name: "rr_preset_group_notify_roles_group_fk",

      columns: [table.presetGroupId],

      foreignColumns: [roleRequestPresetGroups.id],
    }).onDelete("cascade"),

    index("role_request_preset_group_notification_roles_group_idx").on(
      table.presetGroupId,
    ),
  ],
);

/*
 * Which preset role options are displayed by each reusable request group.
 *
 * The same preset option may deliberately be exposed by several groups.
 */
export const roleRequestPresetGroupOptions = pgTable(
  "role_request_preset_group_options",
  {
    groupId: integer("group_id")
      .notNull()
      .references(() => roleRequestPresetGroups.id, {
        onDelete: "cascade",
      }),

    presetOptionId: integer("preset_option_id")
      .notNull()
      .references(() => roleRequestPresetOptions.id, {
        onDelete: "cascade",
      }),

    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "role_request_preset_group_options_pk",

      columns: [table.groupId, table.presetOptionId],
    }),

    index("role_request_preset_group_options_group_idx").on(table.groupId),

    index("role_request_preset_group_options_option_idx").on(
      table.presetOptionId,
    ),
  ],
);

/*
 * Reusable source configuration for creating ordinary persistent events.
 *
 * Templates are not runtime events. Generation snapshots their current source
 * configuration into the existing event-owned tables and scheduled actions.
 *
 * Recurrence is deliberately modelled separately later. One-off template
 * generation must be stable before recurrence is added.
 */
export const eventTemplates = pgTable(
  "event_templates",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    ownerGuildId: integer("owner_guild_id")
      .notNull()
      .references(() => discordGuilds.id, {
        onDelete: "cascade",
      }),

    eventTypeId: integer("event_type_id")
      .notNull()
      .references(() => eventTypes.id, {
        onDelete: "restrict",
      }),

    /*
     * Null means no audience is configured on the template.
     *
     * Generation snapshots the selected audience ID into the ordinary event.
     */
    audienceId: integer("audience_id"),

    /*
     * P1 initially supports zero or one reusable role-request preset per
     * template.
     *
     * The preset is source configuration only. Generation snapshots it into
     * ordinary event-owned role-request state through the existing preset
     * application boundary.
     */
    roleRequestPresetId: integer("role_request_preset_id"),

    name: varchar("name", {
      length: 150,
    }).notNull(),

    description: text("description"),

    timezone: varchar("timezone", {
      length: 64,
    })
      .notNull()
      .default("Europe/London"),

    /*
     * Optional reusable local-time default in HH:MM form.
     *
     * Keeping this nullable allows one-off generation to supply a specific
     * occurrence time when the template itself does not prescribe one.
     */
    localStartTime: varchar("local_start_time", {
      length: 5,
    }),

    durationMinutes: integer("duration_minutes").notNull().default(60),

    signupsEnabled: boolean("signups_enabled").notNull().default(true),

    /*
     * Offset from event start used to resolve attendanceClosesAt when an
     * occurrence is generated.
     *
     * It remains stored even when signups are disabled so re-enabling signups
     * does not discard the reusable closing-time default.
     */
    attendanceCloseMinutesBefore: integer("attendance_close_minutes_before")
      .notNull()
      .default(60),

    showDetailedDeadline: boolean("show_detailed_deadline")
      .notNull()
      .default(false),

    /*
     * Source-level publication intent.
     *
     * Supported values:
     * - manual: create an unpublished event for later manual publication
     * - scheduled: create a durable future publish_event action
     * - immediate: publish through the normal post-commit publication path
     *
     * Runtime events continue to use the existing publication state rather
     * than gaining a second template-specific publication model.
     */
    publicationMode: varchar("publication_mode", {
      length: 16,
    })
      .notNull()
      .default("manual"),

    /*
     * Required only for scheduled publication.
     *
     * Null for manual and immediate source intent.
     */
    publishMinutesBeforeStart: integer("publish_minutes_before_start"),

    /*
     * Null means generation should resolve the guild's current default
     * publication/attendance destination and snapshot the result onto the
     * generated event.
     *
     * A non-null value is a fixed reusable template destination.
     */
    publicationChannelId: text("publication_channel_id"),

    active: boolean("active").notNull().default(true),

    createdByUserId: text("created_by_user_id").notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /*
     * Use explicit short names for new foreign keys rather than relying on
     * generated identifiers approaching PostgreSQL's identifier limit.
     */
    foreignKey({
      name: "evt_tpl_audience_fk",
      columns: [table.audienceId],
      foreignColumns: [eventAudiences.id],
    }).onDelete("set null"),

    foreignKey({
      name: "evt_tpl_preset_fk",
      columns: [table.roleRequestPresetId],
      foreignColumns: [roleRequestPresets.id],
    }).onDelete("set null"),

    check(
      "evt_tpl_pub_mode_chk",
      sql`${table.publicationMode} in ('manual', 'scheduled', 'immediate')`,
    ),

    check(
      "evt_tpl_pub_offset_chk",
      sql`(
        (${table.publicationMode} = 'scheduled'
          and ${table.publishMinutesBeforeStart} is not null)
        or
        (${table.publicationMode} <> 'scheduled'
          and ${table.publishMinutesBeforeStart} is null)
      )`,
    ),

    /*
     * Preserve the existing index names where the old scaffolding already had
     * the same relationship, avoiding pointless drop/recreate churn.
     */
    index("event_templates_owner_guild_idx").on(table.ownerGuildId),

    index("event_templates_event_type_idx").on(table.eventTypeId),

    index("evt_tpl_audience_idx").on(table.audienceId),

    index("evt_tpl_preset_idx").on(table.roleRequestPresetId),
  ],
);

/*
 * Ordered Discord roles which a template will snapshot into event_ping_roles.
 *
 * The readable name is deliberately retained with the reusable source
 * configuration so generation does not depend on Discord role lookup merely
 * to construct the event snapshot.
 */
export const eventTemplatePingRoles = pgTable(
  "event_template_ping_roles",
  {
    templateId: integer("template_id").notNull(),

    discordRoleId: text("discord_role_id").notNull(),

    roleNameSnapshot: varchar("role_name_snapshot", {
      length: 100,
    }).notNull(),

    sortOrder: integer("sort_order").notNull().default(0),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "evt_tpl_ping_roles_pk",
      columns: [table.templateId, table.discordRoleId],
    }),

    foreignKey({
      name: "evt_tpl_ping_roles_tpl_fk",
      columns: [table.templateId],
      foreignColumns: [eventTemplates.id],
    }).onDelete("cascade"),

    index("evt_tpl_ping_roles_order_idx").on(table.templateId, table.sortOrder),
  ],
);

/*
 * Optional organiser defaults for future generated events.
 *
 * Zero rows is a completely valid template state. Templates therefore remain
 * usable when the guild organiser feature is disabled.
 *
 * Generation must treat these rows as source defaults only. When organisers
 * are enabled they become ordinary dormant event_organiser_assignments.
 * When the guild organiser feature is disabled, generation must still succeed
 * without creating organiser assignments.
 *
 * Only primary and backup are reusable defaults. Cover is runtime recovery
 * state and never belongs to template source configuration.
 */
export const eventTemplateOrganiserDefaults = pgTable(
  "event_template_organiser_defaults",
  {
    templateId: integer("template_id").notNull(),

    slot: varchar("slot", {
      length: 16,
    }).notNull(),

    discordUserId: text("discord_user_id").notNull(),

    displayNameSnapshot: varchar("display_name_snapshot", {
      length: 100,
    }).notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "evt_tpl_org_defaults_pk",
      columns: [table.templateId, table.slot],
    }),

    foreignKey({
      name: "evt_tpl_org_tpl_fk",
      columns: [table.templateId],
      foreignColumns: [eventTemplates.id],
    }).onDelete("cascade"),

    /*
     * A single Discord user cannot be both the primary and backup default.
     */
    uniqueIndex("evt_tpl_org_user_uq").on(
      table.templateId,
      table.discordUserId,
    ),

    check("evt_tpl_org_slot_chk", sql`${table.slot} in ('primary', 'backup')`),
  ],
);

/*
 * Reusable reminder definitions.
 *
 * Generation copies each definition into an ordinary event_reminders row and
 * creates the normal durable reminder scheduled action.
 *
 * channelId is nullable deliberately:
 * - non-null -> use this fixed template destination
 * - null -> resolve the generated event's publication destination once and
 *           snapshot that resolved channel into event_reminders.channel_id
 */
export const eventTemplateReminders = pgTable(
  "event_template_reminders",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    templateId: integer("template_id").notNull(),

    /*
     * Initially supported:
     * - event_start
     * - signup_close
     *
     * Keep this aligned with event_reminders rather than creating a separate
     * template-only timing language.
     */
    timingReference: varchar("timing_reference", {
      length: 32,
    }).notNull(),

    minutesBefore: integer("minutes_before").notNull(),

    message: text("message").notNull(),

    channelId: text("channel_id"),

    pingEventRoles: boolean("ping_event_roles").notNull().default(true),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "evt_tpl_reminders_tpl_fk",
      columns: [table.templateId],
      foreignColumns: [eventTemplates.id],
    }).onDelete("cascade"),

    index("evt_tpl_reminders_tpl_idx").on(table.templateId),
  ],
);

/*
 * Reusable recurrence configuration associated with one event template.
 *
 * P1 intentionally supports at most one recurrence series per template.
 *
 * Recurrence remains separate from the template's reusable event defaults.
 * The template owns timezone and normal local start time. This series owns
 * the recurring calendar rule and the local date from which that rule begins.
 */
export const eventTemplateRecurrences = pgTable(
  "event_template_recurrences",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    templateId: integer("template_id").notNull(),

    /*
     * RFC 5545-compatible recurrence-rule source.
     *
     * Validation and canonicalisation belong in the recurrence service rather
     * than in the schema. Do not interpret arbitrary rule text directly from
     * scheduler code.
     */
    recurrenceRule: text("recurrence_rule").notNull(),

    /*
     * Local calendar date anchoring the recurrence.
     *
     * This is deliberately DATE rather than TIMESTAMPTZ. The template's
     * timezone and local start time are applied later when an occurrence is
     * resolved into an absolute startsAt instant.
     */
    startDate: date("start_date", {
      mode: "string",
    }).notNull(),

    active: boolean("active").notNull().default(true),

    /*
     * Durable automatic-materialisation scheduling state.
     *
     * Recurrence sweeping is not event-owned work, so it does not belong in
     * scheduled_actions, whose rows require an event ID.
     *
     * New recurrence series are immediately eligible for their first sweep.
     */
    nextSweepAt: timestamp("next_sweep_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    /*
     * Identifies the worker which currently owns this recurrence sweep.
     *
     * A later claim replaces the token after the previous lease becomes stale.
     * Completion must still hold the matching token before it may publish its
     * operational result.
     */
    sweepClaimToken: text("sweep_claim_token"),

    lastSweepStartedAt: timestamp("last_sweep_started_at", {
      withTimezone: true,
    }),

    lastSweepCompletedAt: timestamp("last_sweep_completed_at", {
      withTimezone: true,
    }),

    /*
     * Current values:
     *
     * success
     * partial_failure
     * failure
     * skipped
     */
    lastSweepOutcome: varchar("last_sweep_outcome", {
      length: 32,
    }),

    /*
     * Human-readable durable diagnostic for the latest completed sweep.
     *
     * Null means the latest sweep completed without a noteworthy diagnostic.
     */
    lastSweepDiagnostic: text("last_sweep_diagnostic"),

    createdByUserId: text("created_by_user_id").notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "evt_tpl_recur_tpl_fk",

      columns: [table.templateId],

      foreignColumns: [eventTemplates.id],
    }).onDelete("restrict"),

    /*
     * P1 exposes one recurrence series per reusable template.
     *
     * This can be relaxed later without changing recurrence IDs or generated
     * occurrence provenance if a real multi-series use case appears.
     */
    uniqueIndex("evt_tpl_recur_template_uq").on(table.templateId),

    index("evt_tpl_recur_active_sweep_idx").on(table.active, table.nextSweepAt),

    check(
      "evt_tpl_recur_sweep_outcome_chk",
      sql`${table.lastSweepOutcome} IS NULL OR ${table.lastSweepOutcome} IN ('success', 'partial_failure', 'failure', 'skipped')`,
    ),
  ],
);

/*
 * One actual event occurrence.
 *
 * This may have been created from a template or created as a one-off event.
 */

export const events = pgTable(
  "events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    templateId: integer("template_id").references(() => eventTemplates.id, {
      onDelete: "restrict",
    }),

    /*
     * Exact reusable-template parent revision snapshotted when this event was
     * generated.
     *
     * Null means either:
     * - the event was not generated from a template, or
     * - it predates exact template-revision provenance.
     *
     * Do not infer a missing historical revision from event creation time.
     */
    templateSourceUpdatedAt: timestamp("template_source_updated_at", {
      withTimezone: true,
    }),

    ownerGuildId: integer("owner_guild_id")
      .notNull()
      .references(() => discordGuilds.id, { onDelete: "restrict" }),

    eventTypeId: integer("event_type_id")
      .notNull()
      .references(() => eventTypes.id, { onDelete: "restrict" }),

    audienceId: integer("audience_id").references(() => eventAudiences.id, {
      onDelete: "set null",
    }),

    /*
     * The IANA timezone used when the organiser entered the event time.
     * startsAt remains the authoritative absolute instant.
     */
    timezone: varchar("timezone", {
      length: 64,
    })
      .notNull()
      .default("Europe/London"),

    name: varchar("name", { length: 150 }).notNull(),

    description: text("description"),

    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),

    endsAt: timestamp("ends_at", { withTimezone: true }),

    showDetailedDeadline: boolean("show_detailed_deadline")
      .notNull()
      .default(false),

    signupsEnabled: boolean("signups_enabled").notNull().default(true),

    attendanceOpensAt: timestamp("attendance_opens_at", {
      withTimezone: true,
    }),

    attendanceClosesAt: timestamp("attendance_closes_at", {
      withTimezone: true,
    }),

    roleRequestsOpenAt: timestamp("role_requests_open_at", {
      withTimezone: true,
    }),

    /*
     * Null means the event exists internally but has not yet been
     * publicly announced.
     *
     * Once set, this records when the normal public event/attendance
     * message was first published.
     */
    publishedAt: timestamp("published_at", {
      withTimezone: true,
    }),

    /*
     * Null means either:
     * - publish immediately; or
     * - this is a manually-held draft.
     *
     * A value means the public event message should be published
     * this many minutes before the event starts.
     */
    publishMinutesBeforeStart: integer("publish_minutes_before_start"),

    /*
     * Snapshot the intended public event channel when the event is created.
     *
     * This prevents a later server-default change from unexpectedly
     * moving an already-scheduled announcement somewhere else.
     */
    publicationChannelId: text("publication_channel_id"),

    status: eventStatusEnum("status").notNull().default("scheduled"),

    createdByUserId: text("created_by_user_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("events_owner_starts_at_idx").on(table.ownerGuildId, table.startsAt),
    index("events_status_starts_at_idx").on(table.status, table.startsAt),
    index("events_template_idx").on(table.templateId),
    index("events_audience_idx").on(table.audienceId),
  ],
);

/*
 * Immutable provenance for events produced by a recurrence series.
 *
 * occurrenceDate identifies the original local calendar slot represented by
 * the generated event. It must not move when events.startsAt is later edited.
 *
 * The composite primary key also acts as the authoritative duplicate-
 * prevention boundary for recurring generation.
 */
export const eventRecurrenceOccurrences = pgTable(
  "event_recurrence_occurrences",
  {
    recurrenceId: integer("recurrence_id").notNull(),

    occurrenceDate: date("occurrence_date", {
      mode: "string",
    }).notNull(),

    eventId: integer("event_id").notNull(),

    generatedAt: timestamp("generated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "evt_recur_occ_pk",

      columns: [table.recurrenceId, table.occurrenceDate],
    }),

    foreignKey({
      name: "evt_recur_occ_recur_fk",

      columns: [table.recurrenceId],

      foreignColumns: [eventTemplateRecurrences.id],
    }).onDelete("restrict"),

    foreignKey({
      name: "evt_recur_occ_event_fk",

      columns: [table.eventId],

      foreignColumns: [events.id],
    }).onDelete("restrict"),

    /*
     * One ordinary event may represent at most one recurrence slot.
     */
    uniqueIndex("evt_recur_occ_event_uq").on(table.eventId),
  ],
);

export const eventPingRoles = pgTable(
  "event_ping_roles",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, {
        onDelete: "cascade",
      }),

    discordRoleId: text("discord_role_id").notNull(),

    /*
     * Preserve the displayed name even if the Discord role is later
     * renamed or deleted.
     */
    roleName: varchar("role_name", {
      length: 100,
    }).notNull(),

    sortOrder: integer("sort_order").notNull().default(0),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.eventId, table.discordRoleId],
    }),

    index("event_ping_roles_event_idx").on(table.eventId),
  ],
);

/*
 * Records which reusable role-request presets have been snapshotted into
 * which events.
 *
 * This gives application an idempotency boundary and prevents accidentally
 * applying the same preset twice to one occurrence.
 */
export const eventRoleRequestPresetApplications = pgTable(
  "event_role_request_preset_applications",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, {
        onDelete: "cascade",
      }),

    presetId: integer("preset_id")
      .notNull()
      .references(() => roleRequestPresets.id, {
        onDelete: "restrict",
      }),

    appliedByUserId: text("applied_by_user_id").notNull(),

    appliedAt: timestamp("applied_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "event_role_request_preset_applications_pk",

      columns: [table.eventId, table.presetId],
    }),

    index("event_role_request_preset_applications_preset_idx").on(
      table.presetId,
    ),
  ],
);

/*
 * Discord messages associated with an event.
 *
 * Keeping these separate allows one event to have attendance and role-request
 * messages in different channels or even different Discord servers.
 */

export const eventMessages = pgTable(
  "event_messages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),

    guildId: integer("guild_id")
      .notNull()
      .references(() => discordGuilds.id, { onDelete: "restrict" }),

    channelId: text("channel_id").notNull(),

    messageId: text("message_id").notNull().unique(),

    kind: eventMessageKindEnum("kind").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    resolvedAt: timestamp("resolved_at", {
      withTimezone: true,
    }),

    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("event_messages_event_idx").on(table.eventId),
    index("event_messages_guild_channel_idx").on(
      table.guildId,
      table.channelId,
    ),
  ],
);

/*
 * One current attendance response per event and Discord user.
 */

export const attendanceResponses = pgTable(
  "attendance_responses",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),

    discordUserId: text("discord_user_id").notNull(),

    sourceGuildId: integer("source_guild_id").references(
      () => discordGuilds.id,
      { onDelete: "set null" },
    ),

    status: attendanceStatusEnum("status").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.eventId, table.discordUserId],
    }),
    index("attendance_responses_user_idx").on(table.discordUserId),
    index("attendance_responses_event_status_idx").on(
      table.eventId,
      table.status,
    ),
  ],
);

/*
 * To track whether an event's actual attendance has been recorded
 */

export const eventAttendanceReports = pgTable("event_attendance_reports", {
  eventId: integer("event_id")
    .primaryKey()
    .references(() => events.id, {
      onDelete: "cascade",
    }),

  /*
   * Examples:
   * manual
   * paste
   * external_bot
   * file
   */
  source: varchar("source", {
    length: 32,
  })
    .notNull()
    .default("manual"),

  /*
   * Optional human-readable information such as the source bot
   * or imported message ID.
   */
  sourceReference: text("source_reference"),

  recordedByUserId: text("recorded_by_user_id").notNull(),

  recordedAt: timestamp("recorded_at", {
    withTimezone: true,
  })
    .notNull()
    .defaultNow(),

  updatedAt: timestamp("updated_at", {
    withTimezone: true,
  })
    .notNull()
    .defaultNow(),
});

/*
 * People who were present at an event
 */

export const actualAttendanceRecords = pgTable(
  "actual_attendance_records",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, {
        onDelete: "cascade",
      }),

    discordUserId: text("discord_user_id").notNull(),

    /*
     * Useful if the member later leaves Discord/the server.
     * The Discord ID remains authoritative.
     */
    displayNameSnapshot: varchar("display_name_snapshot", {
      length: 100,
    }),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.eventId, table.discordUserId],
    }),

    index("actual_attendance_user_idx").on(table.discordUserId),

    index("actual_attendance_event_idx").on(table.eventId),
  ],
);

/*
 * Event-owned logical role choices.
 *
 * These may be configured directly or snapshotted from reusable role-request
 * presets. Once present, they belong to the event and remain independent of
 * later reusable-source edits.
 */

export const eventRoleOptions = pgTable(
  "event_role_options",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),

    sourceRoleRequestPresetOptionId: integer(
      "source_role_request_preset_option_id",
    ).references(() => roleRequestPresetOptions.id, {
      onDelete: "set null",
    }),

    key: varchar("key", { length: 64 }).notNull(),

    displayName: varchar("display_name", { length: 100 }).notNull(),

    description: text("description"),

    /*
     * Controls whether anybody may express interest or whether the
     * member must currently hold one of this option's configured
     * qualification roles.
     *
     * Supported by the application:
     * - open
     * - qualified_only
     */
    requestRestriction: varchar("request_restriction", {
      length: 32,
    })
      .notNull()
      .default("open"),

    capacity: integer("capacity"),

    sortOrder: integer("sort_order").notNull().default(0),

    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("event_role_options_event_key_unique").on(
      table.eventId,
      table.key,
    ),
    index("event_role_options_event_idx").on(table.eventId),
  ],
);

/*
 * Discord roles which indicate qualification for an event role.
 *
 * qualificationLevel is intentionally varchar rather than an enum
 * because more nuanced levels may be useful later.
 *
 * Currently supported:
 * - qualified
 * - supervision_required
 */
export const eventRoleOptionQualificationRoles = pgTable(
  "event_role_option_qualification_roles",
  {
    eventRoleOptionId: integer("event_role_option_id")
      .notNull()
      .references(() => eventRoleOptions.id, {
        onDelete: "cascade",
      }),

    discordRoleId: text("discord_role_id").notNull(),

    roleNameSnapshot: varchar("role_name_snapshot", {
      length: 100,
    }).notNull(),

    qualificationLevel: varchar("qualification_level", {
      length: 32,
    }).notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.eventRoleOptionId, table.discordRoleId],
    }),

    index("event_role_option_qualification_idx").on(table.eventRoleOptionId),
  ],
);

/*
 * One Discord-facing request group.
 *
 * Different groups may expose the same event role option. This lets
 * an early private Captain request and a later general request share
 * exactly the same underlying Captain volunteers.
 */
export const roleRequestGroups = pgTable(
  "role_request_groups",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, {
        onDelete: "cascade",
      }),

    sourceRoleRequestPresetGroupId: integer(
      "source_role_request_preset_group_id",
    ).references(() => roleRequestPresetGroups.id, {
      onDelete: "set null",
    }),

    name: varchar("name", {
      length: 100,
    }).notNull(),

    description: text("description"),

    channelId: text("channel_id").notNull(),

    messageId: text("message_id").unique(),

    /*
     * Persist notification metadata so a request group which was configured
     * before its opening time can later be posted by the scheduler.
     */
    notifyRoleId: text("notify_role_id"),

    notifyRoleNameSnapshot: varchar("notify_role_name_snapshot", {
      length: 100,
    }),

    /*
     * If true, only Attending or Tentative members may add new
     * requests through this group.
     *
     * Existing requests remain event-level records and can therefore
     * still be displayed by another group.
     */
    requiresPositiveSignup: boolean("requires_positive_signup")
      .notNull()
      .default(false),

    /*
     * Optional signed opening offset relative to event start.
     *
     *  60 = 60 minutes before start
     *   0 = at event start
     * -10 = 10 minutes after start
     *
     * A non-null value means this group has an event-start-relative opening
     * rule, such as one snapshotted from a reusable preset.
     *
     * Null means the group has no relative opening rule, for example an
     * administrator-posted group which opened immediately.
     */
    openMinutesBeforeStart: integer("open_minutes_before_start"),

    opensAt: timestamp("opens_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    /*
     * Signed offset relative to event start:
     *
     *  10 = 10 minutes before start
     *   0 = at event start
     * -10 = 10 minutes after start
     *
     * The database column retains its original name for compatibility.
     * Storing both the offset and resolved timestamp lets schedule
     * edits preserve the relationship.
     */
    closeMinutesBeforeStart: integer("close_minutes_before_start")
      .notNull()
      .default(0),

    closesAt: timestamp("closes_at", {
      withTimezone: true,
    }).notNull(),

    /*
     * Non-null means an administrator or scheduler has explicitly
     * closed the group.
     */
    closedAt: timestamp("closed_at", {
      withTimezone: true,
    }),

    createdByUserId: text("created_by_user_id").notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("role_request_groups_event_idx").on(table.eventId),

    index("role_request_groups_closes_at_idx").on(
      table.eventId,
      table.closesAt,
    ),
  ],
);

/*
 * Event-level snapshot of the Discord roles pinged when a request group is
 * published.
 *
 * Preset-derived groups copy their source collection here. Manually-created
 * event groups also store their selected notification roles here.
 *
 * PostgreSQL remains authoritative even if Discord roles are later renamed
 * or deleted.
 */
export const roleRequestGroupNotificationRoles = pgTable(
  "role_request_group_notification_roles",
  {
    groupId: integer("group_id").notNull(),

    discordRoleId: text("discord_role_id").notNull(),

    roleNameSnapshot: varchar("role_name_snapshot", {
      length: 100,
    }),

    sortOrder: integer("sort_order").notNull().default(0),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "role_request_group_notification_roles_pk",

      columns: [table.groupId, table.discordRoleId],
    }),

    foreignKey({
      name: "rr_group_notify_roles_group_fk",

      columns: [table.groupId],

      foreignColumns: [roleRequestGroups.id],
    }).onDelete("cascade"),

    index("role_request_group_notification_roles_group_idx").on(table.groupId),
  ],
);

/*
 * Which logical event roles are displayed by each request group.
 *
 * The same eventRoleOptionId can deliberately appear in several
 * groups.
 */
export const roleRequestGroupOptions = pgTable(
  "role_request_group_options",
  {
    groupId: integer("group_id")
      .notNull()
      .references(() => roleRequestGroups.id, {
        onDelete: "cascade",
      }),

    eventRoleOptionId: integer("event_role_option_id")
      .notNull()
      .references(() => eventRoleOptions.id, {
        onDelete: "cascade",
      }),

    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.groupId, table.eventRoleOptionId],
    }),

    index("role_request_group_options_group_idx").on(table.groupId),

    index("role_request_group_options_role_idx").on(table.eventRoleOptionId),
  ],
);

/*
 * A member expressing willingness to perform a particular role.
 *
 * Requests are independent rather than ranked. A member may therefore
 * request Captain, Carpenter and Gunboat Gunner simultaneously.
 */
export const roleRequests = pgTable(
  "role_requests",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, {
        onDelete: "cascade",
      }),

    discordUserId: text("discord_user_id").notNull(),

    eventRoleOptionId: integer("event_role_option_id")
      .notNull()
      .references(() => eventRoleOptions.id, {
        onDelete: "cascade",
      }),

    /*
     * Records where the request was first made.
     *
     * This is informational only. The request belongs to the EVENT,
     * not permanently to that particular message/group.
     */
    sourceGroupId: integer("source_group_id").references(
      () => roleRequestGroups.id,
      {
        onDelete: "set null",
      },
    ),

    note: text("note"),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("role_requests_user_option_unique").on(
      table.eventId,
      table.discordUserId,
      table.eventRoleOptionId,
    ),

    index("role_requests_event_idx").on(table.eventId),

    index("role_requests_user_idx").on(table.discordUserId),
  ],
);

/*
 * Durable record of reminders and other work due in the future.
 *
 * actionKey values can later include:
 * - attendance-open
 * - attendance-reminder-60
 * - attendance-close
 * - role-requests-open
 * - admin-summary
 */

export const scheduledActions = pgTable(
  "scheduled_actions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),

    actionKey: varchar("action_key", { length: 100 }).notNull(),

    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),

    status: scheduledActionStatusEnum("status").notNull().default("pending"),

    attemptCount: integer("attempt_count").notNull().default(0),

    lockedAt: timestamp("locked_at", { withTimezone: true }),

    completedAt: timestamp("completed_at", { withTimezone: true }),

    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("scheduled_actions_event_key_unique").on(
      table.eventId,
      table.actionKey,
    ),
    index("scheduled_actions_status_due_idx").on(table.status, table.dueAt),
  ],
);

export const eventReminders = pgTable(
  "event_reminders",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, {
        onDelete: "cascade",
      }),

    /*
     * Initially supported:
     * event_start
     * signup_close
     *
     * Kept as varchar so future references such as
     * role_requests_open can be added without an enum migration.
     */
    timingReference: varchar("timing_reference", {
      length: 32,
    }).notNull(),

    minutesBefore: integer("minutes_before").notNull(),

    message: text("message").notNull(),

    /*
     * Store the resolved destination rather than relying on the
     * server default still being the same when the reminder fires.
     */
    channelId: text("channel_id").notNull(),

    pingEventRoles: boolean("ping_event_roles").notNull().default(true),

    enabled: boolean("enabled").notNull().default(true),

    createdByUserId: text("created_by_user_id").notNull(),

    sentAt: timestamp("sent_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    missedAt: timestamp("missed_at", {
      withTimezone: true,
    }),

    missedReason: text("missed_reason"),
  },
  (table) => [
    index("event_reminders_event_idx").on(table.eventId),

    index("event_reminders_enabled_idx").on(table.eventId, table.enabled),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    guildId: integer("guild_id")
      .notNull()
      .references(() => discordGuilds.id, {
        onDelete: "cascade",
      }),

    /*
     * Null represents an automatic/system action.
     */
    actorUserId: text("actor_user_id"),

    action: varchar("action", {
      length: 64,
    }).notNull(),

    /*
     * success | denied | failure | system
     *
     * Kept as varchar rather than an enum so adding new audit
     * outcomes doesn't require a database migration.
     */
    outcome: varchar("outcome", {
      length: 16,
    }).notNull(),

    summary: text("summary").notNull(),

    targetType: varchar("target_type", {
      length: 32,
    }),

    targetId: text("target_id"),

    details: jsonb("details").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_logs_guild_created_idx").on(table.guildId, table.createdAt),

    index("audit_logs_actor_idx").on(table.actorUserId),

    index("audit_logs_action_idx").on(table.action),
  ],
);

export const eventOrganiserAssignments = pgTable(
  "event_organiser_assignments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, {
        onDelete: "cascade",
      }),

    slot: organiserSlotEnum("slot").notNull(),

    discordUserId: text("discord_user_id").notNull(),

    displayNameSnapshot: varchar("display_name_snapshot", {
      length: 100,
    }).notNull(),

    status: organiserStatusEnum("status").notNull().default("pending"),

    isCurrent: boolean("is_current").notNull().default(true),

    assignedByUserId: text("assigned_by_user_id").notNull(),

    assignedAt: timestamp("assigned_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    activatedAt: timestamp("activated_at", {
      withTimezone: true,
    }),

    responseDeadlineAt: timestamp("response_deadline_at", {
      withTimezone: true,
    }),

    /*
     * If the scheduler has posted a pending-response warning, retain its exact
     * Discord location so the warning can later be reconciled when the
     * assignment is confirmed, declined, timed out or otherwise resolved.
     *
     * Store the original channel as well as the message because the guild's
     * configured Event Administration channel may subsequently change.
     */
    warningChannelId: text("warning_channel_id"),

    warningMessageId: text("warning_message_id"),

    respondedAt: timestamp("responded_at", {
      withTimezone: true,
    }),

    endedAt: timestamp("ended_at", {
      withTimezone: true,
    }),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("event_organiser_assignments_event_idx").on(
      table.eventId,
      table.isCurrent,
    ),

    index("event_organiser_assignments_user_idx").on(
      table.discordUserId,
      table.isCurrent,
    ),

    uniqueIndex("event_organiser_assignments_current_slot_unique")
      .on(table.eventId, table.slot)
      .where(sql`${table.isCurrent} = true`),
  ],
);
