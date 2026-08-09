import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  jsonb,
} from "drizzle-orm/pg-core";

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
]);

export const scheduledActionStatusEnum = pgEnum("scheduled_action_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
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

  defaultAttendanceChannelId: text("default_attendance_channel_id"),

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
 * Recurring event configurations.
 *
 * A template describes something like "Sunday Naval Event".
 * An individual occurrence is stored separately in the events table.
 */

export const eventTemplates = pgTable(
  "event_templates",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    ownerGuildId: integer("owner_guild_id")
      .notNull()
      .references(() => discordGuilds.id, { onDelete: "cascade" }),

    eventTypeId: integer("event_type_id")
      .notNull()
      .references(() => eventTypes.id, { onDelete: "restrict" }),

    name: varchar("name", { length: 150 }).notNull(),

    description: text("description"),

    timezone: varchar("timezone", { length: 64 })
      .notNull()
      .default("Europe/London"),

    /*
     * This will eventually contain an RFC 5545 recurrence rule, such as a
     * weekly Friday schedule.
     */
    recurrenceRule: text("recurrence_rule"),

    /*
     * Stored as HH:MM in the template's local timezone.
     * Actual event occurrences use full timestamps.
     */
    localStartTime: varchar("local_start_time", { length: 5 }),

    durationMinutes: integer("duration_minutes"),

    attendanceOpenMinutesBefore: integer("attendance_open_minutes_before")
      .notNull()
      .default(120),

    attendanceCloseMinutesBefore: integer("attendance_close_minutes_before")
      .notNull()
      .default(60),

    roleRequestsOpenMinutesBefore: integer("role_requests_open_minutes_before")
      .notNull()
      .default(60),

    attendanceChannelId: text("attendance_channel_id"),

    roleRequestChannelId: text("role_request_channel_id"),

    pingRoleId: text("ping_role_id"),

    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("event_templates_owner_guild_idx").on(table.ownerGuildId),
    index("event_templates_event_type_idx").on(table.eventTypeId),
  ],
);

/*
 * Default role-request choices attached to a recurring template.
 */

export const templateRoleOptions = pgTable(
  "template_role_options",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    templateId: integer("template_id")
      .notNull()
      .references(() => eventTemplates.id, { onDelete: "cascade" }),

    key: varchar("key", { length: 64 }).notNull(),

    displayName: varchar("display_name", { length: 100 }).notNull(),

    description: text("description"),

    /*
     * Null means that no fixed capacity has been configured.
     */
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
    uniqueIndex("template_role_options_template_key_unique").on(
      table.templateId,
      table.key,
    ),
    index("template_role_options_template_idx").on(table.templateId),
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
      onDelete: "set null",
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

    attendanceOpensAt: timestamp("attendance_opens_at", {
      withTimezone: true,
    }),

    attendanceClosesAt: timestamp("attendance_closes_at", {
      withTimezone: true,
    }),

    roleRequestsOpenAt: timestamp("role_requests_open_at", {
      withTimezone: true,
    }),

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
 * Role choices copied from the template into one actual event.
 *
 * Copying them preserves event history and lets admins customise one
 * occurrence without changing every future event.
 */

export const eventRoleOptions = pgTable(
  "event_role_options",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),

    sourceTemplateRoleOptionId: integer(
      "source_template_role_option_id",
    ).references(() => templateRoleOptions.id, {
      onDelete: "set null",
    }),

    key: varchar("key", { length: 64 }).notNull(),

    displayName: varchar("display_name", { length: 100 }).notNull(),

    description: text("description"),

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
 * Player role preferences.
 *
 * preferenceRank allows us to support second and third choices later without
 * replacing the table. The first implementation may use only rank 1.
 */

export const roleRequests = pgTable(
  "role_requests",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),

    discordUserId: text("discord_user_id").notNull(),

    eventRoleOptionId: integer("event_role_option_id")
      .notNull()
      .references(() => eventRoleOptions.id, {
        onDelete: "cascade",
      }),

    preferenceRank: integer("preference_rank").notNull().default(1),

    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("role_requests_user_option_unique").on(
      table.eventId,
      table.discordUserId,
      table.eventRoleOptionId,
    ),
    uniqueIndex("role_requests_user_rank_unique").on(
      table.eventId,
      table.discordUserId,
      table.preferenceRank,
    ),
    index("role_requests_event_idx").on(table.eventId),
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
