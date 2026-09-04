import {
  type ChatInputCommandInteraction,
  type GuildMember,
  MessageFlags,
  type Role,
} from "discord.js";
import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import {
  attendanceResponses,
  eventAudiences,
  eventPingRoles,
  events,
  eventTypes,
  scheduledActions,
  eventOrganiserAssignments,
} from "../db/schema.js";
import {
  refreshAttendanceMessage,
  type AttendanceRefreshResult,
} from "../events/attendance-refresh.js";
import { reconcileOrganiserPendingWarning } from "../events/organiser-notification.js";
import { isValidEventTimezone } from "../time/timezones.js";
import { handleEventResponses } from "./event-responses.js";
import {
  cancelEventScheduledActions,
  markAttendanceCloseCompleted,
  scheduleAttendanceClose,
} from "../scheduler/action-maintenance.js";
import { writeAuditLog } from "../audit/audit-log.js";
import {
  publishStoredEvent,
  type EventPublicationResult,
} from "../events/event-publication.js";
import { publishEvent } from "./event-publish.js";
import {
  addEventReminder,
  announceEvent,
  editEventReminder,
  listEventReminders,
  removeEventReminder,
} from "./event-reminders.js";
import {
  addEventRoleOption,
  closeRoleRequestGroup,
  listEventRoleOptions,
  listRoleRequestGroups,
  postRoleRequestGroup,
  showEventRoleRequests,
} from "./event-role-requests.js";
import { refreshRoleRequestMessages } from "../role-requests/role-request-message.js";
import { reschedulePendingEventReminders } from "../reminders/reminder-scheduling.js";
import { editEvent } from "./event-edit.js";

import { clearEventOrganiser, setEventOrganiser } from "./event-organisers.js";

const EVENT_DATE_FORMAT = "yyyy-MM-dd HH:mm";

type CachedCommandInteraction = ChatInputCommandInteraction<"cached">;

export async function handleEventCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "This command can only be used in a Discord server.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "create":
      await createEvent(interaction);
      return;

    case "publish":
      await publishEvent(interaction);
      return;

    case "list":
      await listEvents(interaction);
      return;

    case "responses":
      await handleEventResponses(interaction);
      return;

    case "close":
      await closeEvent(interaction);
      return;

    case "reopen":
      await reopenEvent(interaction);
      return;

    case "cancel":
      await cancelEvent(interaction);
      return;

    case "refresh":
      await refreshEvent(interaction);
      return;

    case "organiser-set":
      await setEventOrganiser(interaction);
      return;

    case "organiser-clear":
      await clearEventOrganiser(interaction);
      return;

    case "role-option-add":
      await addEventRoleOption(interaction);
      return;

    case "role-option-list":
      await listEventRoleOptions(interaction);
      return;

    case "role-group-post":
      await postRoleRequestGroup(interaction);
      return;

    case "role-group-list":
      await listRoleRequestGroups(interaction);
      return;

    case "role-group-close":
      await closeRoleRequestGroup(interaction);
      return;

    case "role-requests":
      await showEventRoleRequests(interaction);
      return;

    case "edit":
      await editEvent(interaction);
      return;

    case "reminder-add":
      await addEventReminder(interaction);
      return;

    case "reminder-edit":
      await editEventReminder(interaction);
      return;

    case "reminder-list":
      await listEventReminders(interaction);
      return;

    case "reminder-remove":
      await removeEventReminder(interaction);
      return;

    case "announce":
      await announceEvent(interaction);
      return;

    default:
      throw new Error(`Unknown event subcommand: ${subcommand}`);
  }
}

/*
 * Shared event-admin authorisation
 */

async function getAuthorisedConfiguration(
  interaction: CachedCommandInteraction,
) {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply(
      "This server has not been initialised. " +
        "Run `/setup initialise` first.",
    );

    return null;
  }

  if (!configuration.enabled) {
    await interaction.editReply(
      "Event management is currently disabled for this server.",
    );

    return null;
  }

  if (
    !memberCanManageEvents(interaction.member, configuration.eventAdminRoleId)
  ) {
    await writeAuditLog({
      guildId: configuration.guildId,

      guild: interaction.guild,

      actorUserId: interaction.user.id,

      action: "command.denied",

      outcome: "denied",

      summary: `Denied /event ${interaction.options.getSubcommand()} command attempt.`,

      targetType: "command",

      targetId: `/event ${interaction.options.getSubcommand()}`,
    });

    await interaction.editReply(
      "You need the configured Event Admin role " +
        "or the Manage Server permission to manage events.",
    );

    return null;
  }

  return configuration;
}

/*
 * /event create
 */

async function createEvent(
  interaction: CachedCommandInteraction,
): Promise<void> {
  const configuration = await getAuthorisedConfiguration(interaction);

  if (!configuration) {
    return;
  }

  if (
    !configuration.eventAdminRoleId ||
    !configuration.attendanceChannelId ||
    !configuration.roleRequestChannelId
  ) {
    await interaction.editReply(
      "This server's event defaults are incomplete. " +
        "Run `/setup configure` first.",
    );

    return;
  }

  const eventTypeIdText = interaction.options.getString("event-type", true);

  const eventTypeId = Number(eventTypeIdText);

  if (!Number.isSafeInteger(eventTypeId) || eventTypeId <= 0) {
    await interaction.editReply(
      "The selected event type is invalid. Choose one from the autocomplete list.",
    );

    return;
  }

  const [eventType] = await db
    .select({
      id: eventTypes.id,

      name: eventTypes.name,

      code: eventTypes.code,
    })
    .from(eventTypes)
    .where(
      and(
        eq(eventTypes.id, eventTypeId),

        eq(eventTypes.ownerGuildId, configuration.guildId),

        eq(eventTypes.active, true),
      ),
    )
    .limit(1);

  if (!eventType) {
    await interaction.editReply(
      "That event type is not available for this server.",
    );

    return;
  }

  const audienceIdText = interaction.options.getString("region", true);

  const audienceId = Number(audienceIdText);

  if (!Number.isSafeInteger(audienceId) || audienceId <= 0) {
    await interaction.editReply(
      "The selected region is invalid. Choose one from the autocomplete list.",
    );

    return;
  }

  const [audience] = await db
    .select({
      id: eventAudiences.id,

      code: eventAudiences.code,

      name: eventAudiences.name,

      defaultTimezone: eventAudiences.defaultTimezone,
    })
    .from(eventAudiences)
    .where(
      and(
        eq(eventAudiences.id, audienceId),

        eq(eventAudiences.ownerGuildId, configuration.guildId),

        eq(eventAudiences.active, true),
      ),
    )
    .limit(1);

  if (!audience) {
    await interaction.editReply(
      "That event region is not available for this server.",
    );

    return;
  }

  const timezoneOverride = interaction.options.getString("timezone")?.trim();

  const eventTimezone = timezoneOverride || audience.defaultTimezone;

  if (!isValidEventTimezone(eventTimezone)) {
    await interaction.editReply(
      [
        "The supplied timezone is invalid or ambiguous.",
        "",
        "Choose a named timezone such as:",
        "• `Europe/London`",
        "• `America/New_York`",
        "• `America/Chicago`",
        "• `America/Los_Angeles`",
        "",
        "Do not use abbreviations such as `EST` or `BST`.",
      ].join("\n"),
    );

    return;
  }

  const name = interaction.options.getString("name", true).trim();

  const description =
    interaction.options.getString("description")?.trim() || null;

  const dateText = interaction.options.getString("date", true);

  const timeText = interaction.options.getString("time", true);

  const signupsEnabled = interaction.options.getBoolean("signups") ?? true;

  const publishNowOption = interaction.options.getBoolean("publish-now");

  const publishMinutesBeforeStart = interaction.options.getInteger(
    "publish-minutes-before-start",
  );

  if (publishNowOption === true && publishMinutesBeforeStart !== null) {
    await interaction.editReply(
      [
        "`publish-now` and `publish-minutes-before-start` cannot both be used.",
        "",
        "Either publish the event immediately or schedule it for later.",
      ].join("\n"),
    );

    return;
  }

  const publishNow =
    publishMinutesBeforeStart !== null ? false : (publishNowOption ?? true);

  const durationMinutes =
    interaction.options.getInteger("duration-minutes") ?? 60;

  const closeMinutesBefore =
    interaction.options.getInteger("close-minutes-before") ?? 60;

  const showDetailedDeadline =
    signupsEnabled &&
    (interaction.options.getBoolean("detailed-deadline") ?? false);

  const primaryOrganiserUser = interaction.options.getUser("primary-organiser");

  const backupOrganiserUser = interaction.options.getUser("backup-organiser");

  if (primaryOrganiserUser?.bot || backupOrganiserUser?.bot) {
    await interaction.editReply(
      "Bot accounts cannot be assigned as event organisers.",
    );

    return;
  }

  if (
    primaryOrganiserUser &&
    backupOrganiserUser &&
    primaryOrganiserUser.id === backupOrganiserUser.id
  ) {
    await interaction.editReply(
      "The primary and backup organiser must be different members.",
    );

    return;
  }

  if (backupOrganiserUser && !primaryOrganiserUser) {
    await interaction.editReply(
      "A backup organiser can only be selected when a primary organiser is also assigned.",
    );

    return;
  }

  let primaryOrganiserMember: GuildMember | null = null;

  let backupOrganiserMember: GuildMember | null = null;

  if (primaryOrganiserUser) {
    try {
      primaryOrganiserMember = await interaction.guild.members.fetch(
        primaryOrganiserUser.id,
      );
    } catch {
      await interaction.editReply(
        "The selected primary organiser could not be resolved as a current server member.",
      );

      return;
    }
  }

  if (backupOrganiserUser) {
    try {
      backupOrganiserMember = await interaction.guild.members.fetch(
        backupOrganiserUser.id,
      );
    } catch {
      await interaction.editReply(
        "The selected backup organiser could not be resolved as a current server member.",
      );

      return;
    }
  }

  if (
    configuration.eventOrganiserRoleId &&
    primaryOrganiserMember &&
    !primaryOrganiserMember.roles.cache.has(configuration.eventOrganiserRoleId)
  ) {
    await interaction.editReply(
      "The selected primary organiser does not have the configured Event Organiser role.",
    );

    return;
  }

  if (
    configuration.eventOrganiserRoleId &&
    backupOrganiserMember &&
    !backupOrganiserMember.roles.cache.has(configuration.eventOrganiserRoleId)
  ) {
    await interaction.editReply(
      "The selected backup organiser does not have the configured Event Organiser role.",
    );

    return;
  }

  const selectedPingRoles = [
    interaction.options.getRole("ping-role-1", true),

    interaction.options.getRole("ping-role-2"),

    interaction.options.getRole("ping-role-3"),

    interaction.options.getRole("ping-role-4"),
  ].filter((role): role is Role => role !== null);

  const pingRoles = [
    ...new Map(selectedPingRoles.map((role) => [role.id, role])).values(),
  ];

  const invalidPingRoles = pingRoles.filter(
    (role) => role.id === interaction.guild.id || role.managed,
  );

  if (invalidPingRoles.length > 0) {
    await interaction.editReply({
      content: [
        "One or more selected ping roles cannot be used:",
        "",
        ...invalidPingRoles.map((role) => `• ${role.name}`),
        "",
        "Do not select `@everyone` or roles managed by Discord integrations.",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const parsedStart = parseEventDateTime(dateText, timeText, eventTimezone);

  if (!parsedStart.ok) {
    await interaction.editReply(
      `The event date or time is invalid: ${parsedStart.error}`,
    );

    return;
  }

  const now = DateTime.now().setZone(eventTimezone);

  if (parsedStart.value <= now) {
    await interaction.editReply("The event must start in the future.");

    return;
  }

  const attendanceClosesAt = signupsEnabled
    ? parsedStart.value.minus({
        minutes: closeMinutesBefore,
      })
    : null;

  if (signupsEnabled && attendanceClosesAt && attendanceClosesAt <= now) {
    await interaction.editReply(
      "The attendance deadline would already have passed. " +
        "Use a smaller `close-minutes-before` value or a later event time.",
    );

    return;
  }

  const endsAt = parsedStart.value.plus({
    minutes: durationMinutes,
  });

  const scheduledPublicationAt =
    !publishNow && publishMinutesBeforeStart !== null
      ? parsedStart.value
          .minus({
            minutes: publishMinutesBeforeStart,
          })
          .toJSDate()
      : null;

  if (scheduledPublicationAt && scheduledPublicationAt <= now.toJSDate()) {
    await interaction.editReply(
      [
        "The scheduled publication time would already have passed.",
        "",
        "Use a smaller `publish-minutes-before-start` value or choose a later event time.",
      ].join("\n"),
    );

    return;
  }

  /*
   * Signup events must be published before signups close.
   *
   * Publishing at exactly the same moment as the closing action would
   * create an unnecessary scheduler race, so require it to be earlier.
   */
  if (
    scheduledPublicationAt &&
    signupsEnabled &&
    attendanceClosesAt &&
    scheduledPublicationAt >= attendanceClosesAt.toJSDate()
  ) {
    await interaction.editReply(
      [
        "The event would be published after its signup deadline.",
        "",
        "Schedule publication earlier than the configured attendance closing time.",
      ].join("\n"),
    );

    return;
  }

  const creationResult = await db.transaction(async (transaction) => {
    const [event] = await transaction
      .insert(events)
      .values({
        templateId: null,

        ownerGuildId: configuration.guildId,

        eventTypeId: eventType.id,

        audienceId: audience.id,

        timezone: eventTimezone,

        showDetailedDeadline,

        name,

        description,

        startsAt: parsedStart.value.toJSDate(),

        endsAt: endsAt.toJSDate(),

        /*
         * An unpublished event exists internally but attendance has
         * not yet opened to members.
         */
        attendanceOpensAt: null,

        signupsEnabled,

        attendanceClosesAt: attendanceClosesAt?.toJSDate() ?? null,

        roleRequestsOpenAt: null,

        publishedAt: null,

        publishMinutesBeforeStart,

        publicationChannelId: configuration.attendanceChannelId,

        status: "scheduled",

        createdByUserId: interaction.user.id,

        updatedAt: new Date(),
      })
      .returning({
        id: events.id,

        timezone: events.timezone,

        showDetailedDeadline: events.showDetailedDeadline,

        name: events.name,

        startsAt: events.startsAt,

        signupsEnabled: events.signupsEnabled,

        attendanceClosesAt: events.attendanceClosesAt,
      });

    if (!event) {
      throw new Error("The database did not return the created event.");
    }

    await transaction.insert(eventPingRoles).values(
      pingRoles.map((role, index) => ({
        eventId: event.id,

        discordRoleId: role.id,

        roleName: role.name,

        sortOrder: index,
      })),
    );

    if (primaryOrganiserMember) {
      const [assignment] = await transaction
        .insert(eventOrganiserAssignments)
        .values({
          eventId: event.id,

          slot: "primary",

          discordUserId: primaryOrganiserMember.id,

          displayNameSnapshot: primaryOrganiserMember.displayName,

          status: "pending",

          isCurrent: true,

          assignedByUserId: interaction.user.id,

          /*
           * Organiser responsibility begins when the event becomes public,
           * not merely when its internal event record is created.
           *
           * publishStoredEvent() activates this assignment and creates the
           * warning/timeout actions.
           */
          activatedAt: null,

          responseDeadlineAt: null,

          updatedAt: new Date(),
        })
        .returning({
          id: eventOrganiserAssignments.id,
        });

      if (!assignment) {
        throw new Error(
          "The database did not return the primary organiser assignment.",
        );
      }
    }

    if (backupOrganiserMember) {
      await transaction.insert(eventOrganiserAssignments).values({
        eventId: event.id,

        slot: "backup",

        discordUserId: backupOrganiserMember.id,

        displayNameSnapshot: backupOrganiserMember.displayName,

        status: "pending",

        isCurrent: true,

        assignedByUserId: interaction.user.id,

        activatedAt: null,

        responseDeadlineAt: null,

        updatedAt: new Date(),
      });
    }

    if (scheduledPublicationAt) {
      await transaction.insert(scheduledActions).values({
        eventId: event.id,

        actionKey: "publish_event",

        dueAt: scheduledPublicationAt,

        status: "pending",

        attemptCount: 0,

        updatedAt: new Date(),
      });
    }

    if (signupsEnabled && attendanceClosesAt) {
      await transaction.insert(scheduledActions).values({
        eventId: event.id,

        actionKey: "close_attendance",

        dueAt: attendanceClosesAt.toJSDate(),

        status: "pending",

        attemptCount: 0,

        updatedAt: new Date(),
      });
    }

    await transaction.insert(scheduledActions).values({
      eventId: event.id,

      actionKey: "complete_event",

      dueAt: endsAt.toJSDate(),

      status: "pending",

      attemptCount: 0,

      updatedAt: new Date(),
    });

    return {
      event,
    };
  });

  const createdEvent = creationResult.event;

  let publication: Extract<EventPublicationResult, { ok: true }> | null = null;

  if (publishNow) {
    try {
      const result = await publishStoredEvent(
        interaction.guild,
        createdEvent.id,
      );

      /*
       * A freshly-created event should always be publishable here.
       * Treat any ordinary publication refusal as a creation failure
       * rather than leaving behind an unexpected draft.
       */
      if (!result.ok) {
        throw new Error(
          `The newly-created event could not be published: ${result.reason}.`,
        );
      }

      publication = result;
    } catch (error) {
      /*
       * Immediate creation/publication remains atomic from the user's
       * perspective. If publication fails, remove the newly-created
       * internal event and its cascading records.
       *
       * Manual drafts and scheduled publications never enter this path.
       */
      await db
        .delete(events)
        .where(eq(events.id, createdEvent.id))
        .catch((deleteError: unknown) => {
          console.error(
            `Failed to remove event ${createdEvent.id} after publication failure:`,
            deleteError,
          );
        });

      throw error;
    }
  }

  const primaryNotification = publication?.primaryOrganiserNotification ?? null;

  const organiserStart = DateTime.fromJSDate(createdEvent.startsAt, {
    zone: createdEvent.timezone,
  });

  const publicationTimestamp = scheduledPublicationAt
    ? Math.floor(scheduledPublicationAt.getTime() / 1000)
    : null;

  const responseLines = [
    publishNow
      ? `✅ **${createdEvent.name}** was created and published.`
      : scheduledPublicationAt
        ? `✅ **${createdEvent.name}** was created and scheduled for publication.`
        : `✅ **${createdEvent.name}** was created as an unpublished event.`,
    "",
    `**Event ID:** ${createdEvent.id}`,
    `**Event type:** ${eventType.name}`,
    `**Region:** ${audience.name}`,
    `**Ping roles:** ${pingRoles.map((role) => `<@&${role.id}>`).join(" ")}`,
    `**Scheduled as:** ${organiserStart.toFormat("dd LLL yyyy, HH:mm ZZZZ")}`,
    `**Timezone:** \`${createdEvent.timezone}\``,
    `**Your local time:** <t:${Math.floor(
      createdEvent.startsAt.getTime() / 1000,
    )}:F>`,
    `**Publication:** ${
      publishNow
        ? "Published"
        : publicationTimestamp !== null
          ? `<t:${publicationTimestamp}:F> (<t:${publicationTimestamp}:R>)`
          : "Manual publication"
    }`,
  ];

  if (primaryOrganiserMember) {
    responseLines.push(
      `**Primary organiser:** <@${primaryOrganiserMember.id}>`,
    );
  } else {
    responseLines.push("**Primary organiser:** Not assigned");
  }

  if (backupOrganiserMember) {
    responseLines.push(`**Backup organiser:** <@${backupOrganiserMember.id}>`);
  }

  if (!publishNow && primaryOrganiserMember) {
    responseLines.push(
      "**Organiser confirmation:** Will begin when the event is published",
    );
  } else if (primaryNotification === "dm") {
    responseLines.push("**Organiser confirmation:** DM sent");
  } else if (primaryNotification === "admin_channel") {
    responseLines.push(
      "**Organiser confirmation:** DM failed; fallback posted in the Event Administration channel",
    );
  } else if (primaryNotification === "failed") {
    responseLines.push(
      "**Organiser confirmation:** ⚠️ Assignment saved, but the confirmation request could not be delivered",
    );
  }

  if (createdEvent.signupsEnabled) {
    const closingTime = createdEvent.attendanceClosesAt;

    if (!closingTime) {
      throw new Error(
        "The created signup event did not return an attendance closing time.",
      );
    }

    const organiserClose = DateTime.fromJSDate(closingTime, {
      zone: createdEvent.timezone,
    });

    responseLines.push(
      "**Signups:** Enabled",
      `**Attendance closes:** ${organiserClose.toFormat(
        "dd LLL yyyy, HH:mm ZZZZ",
      )}`,
      `**Closure in your local time:** <t:${Math.floor(
        closingTime.getTime() / 1000,
      )}:F>`,
      `**Detailed deadline:** ${
        createdEvent.showDetailedDeadline ? "Yes" : "No"
      }`,
    );
  } else {
    responseLines.push("**Signups:** Disabled");
  }

  if (publication) {
    responseLines.push(`**Event message:** ${publication.messageUrl}`);
  } else if (publicationTimestamp !== null) {
    responseLines.push(
      `**Public announcement:** Scheduled for <t:${publicationTimestamp}:F> (<t:${publicationTimestamp}:R>)`,
      `**Manual override:** \`/event publish event-id:${createdEvent.id}\` can still publish it earlier.`,
    );
  } else {
    responseLines.push(
      `**Public announcement:** Not yet published. Use \`/event publish event-id:${createdEvent.id}\` when ready.`,
    );
  }

  await interaction.editReply({
    content: responseLines.join("\n"),

    allowedMentions: {
      parse: [],
    },
  });

  await writeAuditLog({
    guildId: configuration.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.create",

    outcome: "success",

    summary: `Created event "${createdEvent.name}" (#${createdEvent.id})${
      publishNow
        ? " and published it"
        : scheduledPublicationAt
          ? " with scheduled publication"
          : " as unpublished"
    }.`,

    targetType: "event",

    targetId: String(createdEvent.id),

    details: {
      eventType: eventType.code,

      region: audience.code,

      signupsEnabled: createdEvent.signupsEnabled,

      publishNow,

      publishMinutesBeforeStart,

      scheduledPublicationAt: scheduledPublicationAt?.toISOString() ?? null,

      startsAt: createdEvent.startsAt.toISOString(),

      pingRoleIds: pingRoles.map((role) => role.id),

      primaryOrganiserUserId: primaryOrganiserMember?.id ?? null,

      backupOrganiserUserId: backupOrganiserMember?.id ?? null,

      primaryOrganiserNotification: primaryNotification,
    },
  });
}

/*
 * /event list
 */

async function listEvents(
  interaction: CachedCommandInteraction,
): Promise<void> {
  const configuration = await getAuthorisedConfiguration(interaction);

  if (!configuration) {
    return;
  }

  const upcomingEvents = await db
    .select({
      id: events.id,

      name: events.name,

      status: events.status,

      publishedAt: events.publishedAt,

      publishMinutesBeforeStart: events.publishMinutesBeforeStart,

      startsAt: events.startsAt,

      signupsEnabled: events.signupsEnabled,

      audienceName: eventAudiences.name,

      publicationActionStatus: scheduledActions.status,

      publicationDueAt: scheduledActions.dueAt,
    })
    .from(events)
    .leftJoin(eventAudiences, eq(eventAudiences.id, events.audienceId))
    .leftJoin(
      scheduledActions,
      and(
        eq(scheduledActions.eventId, events.id),

        eq(scheduledActions.actionKey, "publish_event"),
      ),
    )
    .where(
      and(
        eq(events.ownerGuildId, configuration.guildId),

        gte(events.startsAt, new Date()),
      ),
    )
    .orderBy(asc(events.startsAt))
    .limit(10);

  if (upcomingEvents.length === 0) {
    await interaction.editReply(
      "There are no upcoming events stored for this server.",
    );

    return;
  }

  /*
   * Only active, published signup events need attendance counts.
   *
   * Closed published events are deliberately included because their
   * final signup totals remain useful to organisers.
   */
  const signupEventIds = upcomingEvents
    .filter(
      (event) =>
        event.signupsEnabled &&
        event.publishedAt !== null &&
        event.status !== "cancelled" &&
        event.status !== "completed",
    )
    .map((event) => event.id);

  const attendanceRows =
    signupEventIds.length > 0
      ? await db
          .select({
            eventId: attendanceResponses.eventId,

            status: attendanceResponses.status,

            count: sql<number>`count(*)::int`,
          })
          .from(attendanceResponses)
          .where(inArray(attendanceResponses.eventId, signupEventIds))
          .groupBy(attendanceResponses.eventId, attendanceResponses.status)
      : [];

  const countsByEvent = new Map<
    number,
    {
      attending: number;
      tentative: number;
      notAttending: number;
    }
  >();

  for (const row of attendanceRows) {
    const current = countsByEvent.get(row.eventId) ?? {
      attending: 0,

      tentative: 0,

      notAttending: 0,
    };

    switch (row.status) {
      case "attending":
        current.attending = row.count;
        break;

      case "tentative":
        current.tentative = row.count;
        break;

      case "not_attending":
        current.notAttending = row.count;
        break;
    }

    countsByEvent.set(row.eventId, current);
  }

  const now = new Date();

  const lines = upcomingEvents.flatMap((event) => {
    const timestamp = Math.floor(event.startsAt.getTime() / 1000);

    const publicationState = event.publishedAt ? "Published" : "Unpublished";

    let summary: string;

    /*
     * Terminal event states take precedence over the publication
     * schedule. A cancelled event must never continue advertising a
     * publication countdown merely because it once had one.
     */
    if (event.status === "cancelled") {
      summary = event.publishedAt
        ? "🚫 Event cancelled"
        : "🚫 Event cancelled before publication";
    } else if (event.status === "completed") {
      summary = event.publishedAt
        ? "🏁 Event completed"
        : "🏁 Event completed without publication";
    } else if (!event.publishedAt && event.status === "closed") {
      /*
       * This can happen when a manually-held signup event reaches its
       * signup deadline before it is published.
       */
      summary = "🔒 Unpublished • signup deadline has passed";
    } else if (!event.publishedAt) {
      /*
       * A null publication offset represents a manually-held draft.
       */
      if (event.publishMinutesBeforeStart === null) {
        summary = "📝 Unpublished • manual publication";
      } else {
        /*
         * The scheduled action is the authoritative source for
         * whether automatic publication is still actually pending.
         */
        switch (event.publicationActionStatus) {
          case "pending": {
            if (!event.publicationDueAt) {
              summary =
                "⚠️ Publication is scheduled, but its due time is unavailable";
              break;
            }

            const publicationTimestamp = Math.floor(
              event.publicationDueAt.getTime() / 1000,
            );

            summary =
              event.publicationDueAt > now
                ? `🕒 Publishes <t:${publicationTimestamp}:R>`
                : "⏳ Publication is due and awaiting scheduler processing";

            break;
          }

          case "processing":
            summary = "⏳ Automatic publication is being processed";
            break;

          case "failed":
            summary =
              "⚠️ Automatic publication failed • manual publication is still available";
            break;

          case "cancelled":
            summary =
              "📝 Unpublished • automatic publication has been cancelled";
            break;

          case "completed":
            /*
             * A completed publication action paired with publishedAt=null
             * means the action ran but publication did not occur, for
             * example because its useful publication window had passed.
             */
            summary =
              "⚠️ Automatic publication completed without publishing the event";
            break;

          default:
            summary =
              "⚠️ Publication schedule configured, but no scheduler action was found";
            break;
        }
      }
    } else if (event.signupsEnabled) {
      const counts = countsByEvent.get(event.id) ?? {
        attending: 0,

        tentative: 0,

        notAttending: 0,
      };

      summary =
        `✅ ${counts.attending}  ` +
        `❔ ${counts.tentative}  ` +
        `❌ ${counts.notAttending}`;
    } else {
      summary = "📢 Signups disabled";
    }

    return [
      `**#${event.id} — ${event.name}**`,

      `${event.audienceName ?? "Unspecified"} • ` +
        `${formatEventStatus(event.status)} • ` +
        `${publicationState} • ` +
        `<t:${timestamp}:F>`,

      summary,

      "",
    ];
  });

  await interaction.editReply({
    content: [
      "**Upcoming events**",
      "",
      ...lines,
      "Use the event ID with `/event publish`, `/event edit`, `/event close`, `/event reopen`, `/event cancel` or `/event refresh` as appropriate.",
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

/*
 * /event close
 */

async function closeEvent(
  interaction: CachedCommandInteraction,
): Promise<void> {
  const configuration = await getAuthorisedConfiguration(interaction);

  if (!configuration) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedEvent(configuration.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (!event.signupsEnabled) {
    await interaction.editReply("This event does not use attendance signups.");

    return;
  }

  if (!event.publishedAt) {
    await interaction.editReply(
      "This event has not been published yet, so there are no public attendance signups to close.",
    );

    return;
  }

  if (event.status === "cancelled") {
    await interaction.editReply(
      `Event #${eventId} is cancelled and cannot be closed.`,
    );

    return;
  }

  if (event.status === "completed") {
    await interaction.editReply(`Event #${eventId} is already completed.`);

    return;
  }

  if (event.status === "closed") {
    await interaction.editReply(`Event #${eventId} is already closed.`);

    return;
  }

  const now = new Date();

  const [closedEvent] = await db
    .update(events)
    .set({
      status: "closed",

      attendanceClosesAt: now,

      updatedAt: now,
    })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.ownerGuildId, configuration.guildId),

        /*
         * The event may change after our earlier SELECT.
         *
         * Only apply this close if it is still in the exact lifecycle
         * state that we validated above. In particular, cancellation or
         * completion winning a concurrent race must remain final.
         */
        eq(events.status, event.status),
      ),
    )
    .returning({
      id: events.id,
    });

  if (!closedEvent) {
    await interaction.editReply(
      `Event #${eventId} changed while the close command was being processed. No attendance changes were made.`,
    );

    return;
  }

  const refreshResult = await refreshAttendanceMessage(
    interaction.guild,
    eventId,
  );

  await markAttendanceCloseCompleted(eventId, now);
  await reschedulePendingEventReminders(eventId);

  await interaction.editReply({
    content: [
      `🔒 **${event.name}** (#${event.id}) is now closed for attendance.`,
      formatRefreshResult(refreshResult),
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
  await writeAuditLog({
    guildId: configuration.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.close",

    outcome: "success",

    summary: `Closed attendance for "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),
  });
}

/*
 * /event reopen
 */

async function reopenEvent(
  interaction: CachedCommandInteraction,
): Promise<void> {
  const configuration = await getAuthorisedConfiguration(interaction);

  if (!configuration) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const closeMinutesBefore =
    interaction.options.getInteger("close-minutes-before") ?? 0;

  const event = await findOwnedEvent(configuration.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (!event.signupsEnabled) {
    await interaction.editReply("This event does not use attendance signups.");

    return;
  }

  if (!event.publishedAt) {
    await interaction.editReply(
      "This event has not been published yet, so there are no public attendance signups to close.",
    );

    return;
  }

  if (event.status === "cancelled") {
    await interaction.editReply(
      "A cancelled event cannot currently be reopened. " +
        "Cancellation is treated as a final administrative state.",
    );

    return;
  }

  if (event.status === "completed") {
    await interaction.editReply("A completed event cannot be reopened.");

    return;
  }

  const now = new Date();

  if (event.startsAt <= now) {
    await interaction.editReply(
      "Attendance cannot be reopened because the event has already started.",
    );

    return;
  }

  const newClosingTime = new Date(
    event.startsAt.getTime() - closeMinutesBefore * 60_000,
  );

  if (newClosingTime <= now) {
    await interaction.editReply(
      "That closing deadline would already be in the past. " +
        "Use a smaller `close-minutes-before` value.",
    );

    return;
  }

  const [reopenedEvent] = await db
    .update(events)
    .set({
      status: "open",

      attendanceClosesAt: newClosingTime,

      updatedAt: now,
    })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.ownerGuildId, configuration.guildId),

        /*
         * The event may have changed after our earlier SELECT.
         *
         * Only reopen attendance if the event is still in the exact
         * lifecycle state we validated. In particular, cancellation or
         * completion winning a concurrent race must remain final.
         */
        eq(events.status, event.status),
      ),
    )
    .returning({
      id: events.id,
    });

  if (!reopenedEvent) {
    await interaction.editReply(
      `Event #${eventId} changed while the reopen command was being processed. No attendance changes were made.`,
    );

    return;
  }

  await scheduleAttendanceClose(eventId, newClosingTime);
  await reschedulePendingEventReminders(eventId);

  const refreshResult = await refreshAttendanceMessage(
    interaction.guild,
    eventId,
  );

  const closingTimestamp = Math.floor(newClosingTime.getTime() / 1000);

  await interaction.editReply({
    content: [
      `🔓 **${event.name}** (#${event.id}) is open for attendance again.`,
      `New closing deadline: <t:${closingTimestamp}:F> (<t:${closingTimestamp}:R>)`,
      formatRefreshResult(refreshResult),
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
  await writeAuditLog({
    guildId: configuration.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.reopen",

    outcome: "success",

    summary: `Reopened attendance for "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),

    details: {
      attendanceClosesAt: newClosingTime.toISOString(),
    },
  });
}

/*
 * /event cancel
 */

async function cancelEvent(
  interaction: CachedCommandInteraction,
): Promise<void> {
  const configuration = await getAuthorisedConfiguration(interaction);

  if (!configuration) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedEvent(configuration.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (event.status === "cancelled") {
    await interaction.editReply(`Event #${eventId} is already cancelled.`);

    return;
  }

  if (event.status === "completed") {
    await interaction.editReply("A completed event cannot be cancelled.");

    return;
  }

  const now = new Date();

  const [cancelledEvent] = await db
    .update(events)
    .set({
      status: "cancelled",

      updatedAt: now,
    })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.ownerGuildId, configuration.guildId),

        /*
         * Cancellation was validated using the lifecycle state read above.
         *
         * If completion or another lifecycle transition changes that state
         * before this UPDATE executes, the stale cancellation must lose
         * rather than overwrite the newer authoritative state.
         */
        eq(events.status, event.status),
      ),
    )
    .returning({
      id: events.id,
    });

  if (!cancelledEvent) {
    await interaction.editReply(
      `Event #${eventId} changed while the cancellation was being processed. No cancellation changes were made.`,
    );

    return;
  }

  await cancelEventScheduledActions(eventId);

  /*
   * Cancellation leaves organiser assignment history intact, but any warning
   * belonging to a still-current pending assignment is now obsolete.
   *
   * Read these only after the event cancellation is authoritative so Discord
   * presentation always follows PostgreSQL state.
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
      guild: interaction.guild,

      assignmentId: assignment.id,
    }).catch((error: unknown) => {
      /*
       * Event cancellation is already authoritative. Failure to tidy an old
       * Discord warning must not undo or misreport the cancellation.
       */
      console.error(
        `Failed to reconcile organiser warning for assignment ${assignment.id} after event cancellation:`,
        error,
      );
    });
  }

  const refreshResult = event.publishedAt
    ? await refreshAttendanceMessage(interaction.guild, eventId)
    : null;

  await refreshRoleRequestMessages(interaction.guild, eventId);

  await interaction.editReply({
    content: [
      `🚫 **${event.name}** (#${event.id}) has been cancelled.`,
      "Existing attendance responses have been retained.",
      refreshResult
        ? formatRefreshResult(refreshResult)
        : "No public event message had been published.",
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });

  await writeAuditLog({
    guildId: configuration.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.cancel",

    outcome: "success",

    summary: `Cancelled "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),
  });
}

/*
 * /event refresh
 */

async function refreshEvent(
  interaction: CachedCommandInteraction,
): Promise<void> {
  const configuration = await getAuthorisedConfiguration(interaction);

  if (!configuration) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  /*
   * Use a separate initial variable so that after the null check,
   * `event` itself has a permanently non-null inferred type.
   */
  const foundEvent = await findOwnedEvent(configuration.guildId, eventId);

  if (!foundEvent) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (!foundEvent.publishedAt) {
    await interaction.editReply(
      [
        `**${foundEvent.name}** (#${foundEvent.id}) is still unpublished.`,
        "",
        "There is no public event message to refresh yet.",
        `Use \`/event publish event-id:${foundEvent.id}\` when it should go live.`,
      ].join("\n"),
    );

    return;
  }

  let event = foundEvent;

  const now = new Date();

  /*
   * A refresh may perform the overdue attendance-close transition
   * for signup events if the scheduler has not yet done so.
   *
   * No-signup events use status "scheduled", so they never enter
   * this branch.
   */
  if (
    event.signupsEnabled &&
    event.status === "open" &&
    ((event.attendanceClosesAt && event.attendanceClosesAt <= now) ||
      event.startsAt <= now)
  ) {
    const [updatedEvent] = await db
      .update(events)
      .set({
        status: "closed",

        updatedAt: now,
      })
      .where(
        and(
          eq(events.id, eventId),

          eq(events.ownerGuildId, configuration.guildId),
        ),
      )
      .returning({
        id: events.id,

        name: events.name,

        status: events.status,

        publishedAt: events.publishedAt,

        startsAt: events.startsAt,

        signupsEnabled: events.signupsEnabled,

        attendanceClosesAt: events.attendanceClosesAt,
      });

    await markAttendanceCloseCompleted(eventId, now);

    if (updatedEvent) {
      event = updatedEvent;
    }
  }

  const refreshResult = await refreshAttendanceMessage(
    interaction.guild,
    eventId,
  );

  if (!refreshResult.ok) {
    await interaction.editReply(
      [
        `The database record for **${event.name}** (#${event.id}) exists, but its Discord event message could not be refreshed.`,
        "",
        formatRefreshResult(refreshResult),
      ].join("\n"),
    );

    return;
  }

  await interaction.editReply({
    content: [
      `🔄 **${event.name}** (#${event.id}) was rebuilt from the database.`,
      `Event message: ${refreshResult.messageUrl}`,
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });

  await writeAuditLog({
    guildId: configuration.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.refresh",

    outcome: "success",

    summary: `Refreshed the Discord event message for "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),
  });
}

/*
 * Shared database helpers
 */

async function findOwnedEvent(guildDatabaseId: number, eventId: number) {
  const [event] = await db
    .select({
      id: events.id,
      name: events.name,
      status: events.status,
      publishedAt: events.publishedAt,
      startsAt: events.startsAt,
      signupsEnabled: events.signupsEnabled,
      attendanceClosesAt: events.attendanceClosesAt,
    })
    .from(events)
    .where(
      and(eq(events.id, eventId), eq(events.ownerGuildId, guildDatabaseId)),
    )
    .limit(1);

  return event ?? null;
}

function formatRefreshResult(result: AttendanceRefreshResult): string {
  if (result.ok) {
    return `Attendance message updated: ${result.messageUrl}`;
  }

  switch (result.reason) {
    case "not-linked":
      return (
        "⚠️ No attendance message is linked to this event. " +
        "The database change was still saved."
      );

    case "channel-unavailable":
      return (
        "⚠️ The stored attendance channel is unavailable. " +
        "The database change was still saved."
      );

    case "message-unavailable":
      return (
        "⚠️ The stored attendance message could not be fetched. " +
        "It may have been manually deleted. The database change was still saved."
      );
  }
}

function formatEventStatus(
  status: "scheduled" | "open" | "closed" | "cancelled" | "completed",
): string {
  switch (status) {
    case "scheduled":
      return "Scheduled";

    case "open":
      return "Open";

    case "closed":
      return "Closed";

    case "cancelled":
      return "Cancelled";

    case "completed":
      return "Completed";
  }
}

/*
 * Existing date/time parser
 */

type ParsedEventDateTime =
  | {
      ok: true;
      value: DateTime;
    }
  | {
      ok: false;
      error: string;
    };

function parseEventDateTime(
  dateText: string,
  timeText: string,
  timezone: string,
): ParsedEventDateTime {
  const input = `${dateText} ${timeText}`;

  const parsed = DateTime.fromFormat(input, EVENT_DATE_FORMAT, {
    zone: timezone,

    locale: "en-GB",

    setZone: true,
  });

  if (!parsed.isValid) {
    return {
      ok: false,

      error:
        parsed.invalidExplanation ?? "the supplied value could not be parsed",
    };
  }

  if (parsed.toFormat(EVENT_DATE_FORMAT) !== input) {
    return {
      ok: false,

      error:
        "use a real date and a 24-hour time in " +
        "`YYYY-MM-DD` and `HH:mm` format",
    };
  }

  if (parsed.getPossibleOffsets().length > 1) {
    return {
      ok: false,

      error:
        "that local time occurs twice because of the " +
        "daylight-saving clock change; choose an unambiguous time",
    };
  }

  return {
    ok: true,
    value: parsed,
  };
}
