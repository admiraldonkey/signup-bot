import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  type Role,
} from "discord.js";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import {
  attendanceResponses,
  eventAudiences,
  eventMessages,
  eventPingRoles,
  events,
  eventTypes,
} from "../db/schema.js";
import {
  buildAttendanceButtons,
  buildAttendanceEmbed,
  EMPTY_ATTENDANCE_COUNTS,
} from "../events/attendance-message.js";
import {
  refreshAttendanceMessage,
  type AttendanceRefreshResult,
} from "../events/attendance-refresh.js";
import { isValidEventTimezone } from "../time/timezones.js";

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

    case "list":
      await listEvents(interaction);
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

  /*
   * Event type
   */

  const eventTypeIdText = interaction.options.getString("event-type", true);

  const eventTypeId = Number(eventTypeIdText);

  if (!Number.isSafeInteger(eventTypeId) || eventTypeId <= 0) {
    await interaction.editReply(
      "The selected event type is invalid. " +
        "Choose one from the autocomplete list.",
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

  /*
   * Region
   */

  const audienceIdText = interaction.options.getString("region", true);

  const audienceId = Number(audienceIdText);

  if (!Number.isSafeInteger(audienceId) || audienceId <= 0) {
    await interaction.editReply(
      "The selected region is invalid. " +
        "Choose one from the autocomplete list.",
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

  /*
   * Timezone
   */

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

  /*
   * Ordinary event fields
   */

  const name = interaction.options.getString("name", true).trim();

  const description =
    interaction.options.getString("description")?.trim() || null;

  const dateText = interaction.options.getString("date", true);

  const timeText = interaction.options.getString("time", true);

  const durationMinutes =
    interaction.options.getInteger("duration-minutes") ?? 120;

  const closeMinutesBefore =
    interaction.options.getInteger("close-minutes-before") ?? 60;

  const showDetailedDeadline =
    interaction.options.getBoolean("detailed-deadline") ?? false;

  /*
   * Per-event ping roles
   */

  const selectedPingRoles = [
    interaction.options.getRole("ping-role-1", true),

    interaction.options.getRole("ping-role-2"),

    interaction.options.getRole("ping-role-3"),

    interaction.options.getRole("ping-role-4"),
  ].filter((role): role is Role => role !== null);

  const pingRoles = [
    ...new Map(selectedPingRoles.map((role) => [role.id, role])).values(),
  ];

  if (pingRoles.length === 0) {
    await interaction.editReply("At least one ping role must be selected.");

    return;
  }

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

  /*
   * Parse event time
   */

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

  const attendanceClosesAt = parsedStart.value.minus({
    minutes: closeMinutesBefore,
  });

  if (attendanceClosesAt <= now) {
    await interaction.editReply(
      "The attendance deadline would already have passed. " +
        "Use a smaller `close-minutes-before` value or a later event time.",
    );

    return;
  }

  const endsAt = parsedStart.value.plus({
    minutes: durationMinutes,
  });

  /*
   * Attendance channel
   */

  const attendanceChannel = await interaction.guild.channels.fetch(
    configuration.attendanceChannelId,
  );

  if (
    !attendanceChannel ||
    (attendanceChannel.type !== ChannelType.GuildText &&
      attendanceChannel.type !== ChannelType.GuildAnnouncement) ||
    !attendanceChannel.isSendable()
  ) {
    await interaction.editReply(
      "The configured attendance channel no longer exists " +
        "or cannot receive messages. Run `/setup configure` again.",
    );

    return;
  }

  const botMember =
    interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());

  const channelPermissions = attendanceChannel.permissionsFor(botMember);

  const missingPermissions: string[] = [];

  if (!channelPermissions.has(PermissionFlagsBits.ViewChannel)) {
    missingPermissions.push("View Channel");
  }

  if (!channelPermissions.has(PermissionFlagsBits.SendMessages)) {
    missingPermissions.push("Send Messages");
  }

  if (!channelPermissions.has(PermissionFlagsBits.EmbedLinks)) {
    missingPermissions.push("Embed Links");
  }

  if (!channelPermissions.has(PermissionFlagsBits.ReadMessageHistory)) {
    missingPermissions.push("Read Message History");
  }

  if (missingPermissions.length > 0) {
    await interaction.editReply(
      [
        "The event could not be posted because the bot is missing:",
        "",
        ...missingPermissions.map((permission) => `• ${permission}`),
      ].join("\n"),
    );

    return;
  }

  const canMentionRestrictedRoles = channelPermissions.has(
    PermissionFlagsBits.MentionEveryone,
  );

  const unmentionableRoles = pingRoles.filter(
    (role) => !role.mentionable && !canMentionRestrictedRoles,
  );

  if (unmentionableRoles.length > 0) {
    await interaction.editReply({
      content: [
        "The bot cannot mention these roles:",
        "",
        ...unmentionableRoles.map((role) => `• ${role.name}`),
        "",
        "Make the roles mentionable, or grant the bot “Mention @everyone, @here, and All Roles” in the attendance channel.",
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  /*
   * Create the database records and Discord message.
   */

  let createdEventId: number | null = null;

  let sentMessage: Message | null = null;

  try {
    const createdEvent = await db.transaction(async (transaction) => {
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

          attendanceOpensAt: now.toJSDate(),

          attendanceClosesAt: attendanceClosesAt.toJSDate(),

          roleRequestsOpenAt: null,

          status: "open",

          createdByUserId: interaction.user.id,

          updatedAt: new Date(),
        })
        .returning({
          id: events.id,

          timezone: events.timezone,

          showDetailedDeadline: events.showDetailedDeadline,

          name: events.name,

          description: events.description,

          startsAt: events.startsAt,

          attendanceClosesAt: events.attendanceClosesAt,

          status: events.status,
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

      return event;
    });

    createdEventId = createdEvent.id;

    const createdAttendanceClosesAt = createdEvent.attendanceClosesAt;

    if (!createdAttendanceClosesAt) {
      throw new Error(
        "The created event did not return an attendance closing time.",
      );
    }

    const organiserStart = DateTime.fromJSDate(createdEvent.startsAt, {
      zone: createdEvent.timezone,
    });

    const organiserClose = DateTime.fromJSDate(createdAttendanceClosesAt, {
      zone: createdEvent.timezone,
    });

    const eventDisplay = {
      ...createdEvent,

      audienceName: audience.name,

      eventTypeName: eventType.name,
    };

    sentMessage = await attendanceChannel.send({
      content: pingRoles.map((role) => `<@&${role.id}>`).join(" "),

      embeds: [buildAttendanceEmbed(eventDisplay, EMPTY_ATTENDANCE_COUNTS)],

      components: [
        buildAttendanceButtons(createdEvent.id, EMPTY_ATTENDANCE_COUNTS),
      ],

      allowedMentions: {
        parse: [],

        roles: pingRoles.map((role) => role.id),
      },
    });

    await db.insert(eventMessages).values({
      eventId: createdEvent.id,

      guildId: configuration.guildId,

      channelId: attendanceChannel.id,

      messageId: sentMessage.id,

      kind: "attendance",
    });

    await interaction.editReply({
      content: [
        `✅ **${createdEvent.name}** was created.`,
        "",
        `**Event type:** ${eventType.name}`,
        `**Region:** ${audience.name}`,
        `**Ping roles:** ${pingRoles
          .map((role) => `<@&${role.id}>`)
          .join(" ")}`,
        `**Scheduled as:** ${organiserStart.toFormat(
          "dd LLL yyyy, HH:mm ZZZZ",
        )}`,
        `**Timezone:** \`${createdEvent.timezone}\``,
        `**Your local time:** <t:${Math.floor(
          createdEvent.startsAt.getTime() / 1000,
        )}:F>`,
        `**Attendance closes:** ${organiserClose.toFormat(
          "dd LLL yyyy, HH:mm ZZZZ",
        )}`,
        `**Closure in your local time:** <t:${Math.floor(
          createdAttendanceClosesAt.getTime() / 1000,
        )}:F>`,
        `**Detailed deadline:** ${
          createdEvent.showDetailedDeadline ? "Yes" : "No"
        }`,
        `**Sign-up message:** ${sentMessage.url}`,
      ].join("\n"),

      allowedMentions: {
        parse: [],
      },
    });
  } catch (error) {
    if (sentMessage) {
      await sentMessage.delete().catch((deleteError: unknown) => {
        console.error(
          "Failed to remove the partially created Discord message:",
          deleteError,
        );
      });
    }

    if (createdEventId !== null) {
      await db
        .delete(events)
        .where(eq(events.id, createdEventId))
        .catch((deleteError: unknown) => {
          console.error(
            "Failed to remove the partially created event:",
            deleteError,
          );
        });
    }

    throw error;
  }
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

      startsAt: events.startsAt,

      audienceName: eventAudiences.name,
    })
    .from(events)
    .leftJoin(eventAudiences, eq(eventAudiences.id, events.audienceId))
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

  const eventIds = upcomingEvents.map((event) => event.id);

  const attendanceRows = await db
    .select({
      eventId: attendanceResponses.eventId,

      status: attendanceResponses.status,

      count: sql<number>`count(*)::int`,
    })
    .from(attendanceResponses)
    .where(inArray(attendanceResponses.eventId, eventIds))
    .groupBy(attendanceResponses.eventId, attendanceResponses.status);

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

  const lines = upcomingEvents.flatMap((event) => {
    const counts = countsByEvent.get(event.id) ?? {
      attending: 0,
      tentative: 0,
      notAttending: 0,
    };

    const timestamp = Math.floor(event.startsAt.getTime() / 1000);

    return [
      `**#${event.id} — ${event.name}**`,
      `${event.audienceName ?? "Unspecified"} • ${formatEventStatus(
        event.status,
      )} • <t:${timestamp}:F>`,
      `✅ ${counts.attending}  ❔ ${counts.tentative}  ❌ ${counts.notAttending}`,
      "",
    ];
  });

  await interaction.editReply({
    content: [
      "**Upcoming events**",
      "",
      ...lines,
      "Use the event ID with `/event close`, `/event reopen`, `/event cancel` or `/event refresh`.",
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

  await db
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
      ),
    );

  const refreshResult = await refreshAttendanceMessage(
    interaction.guild,
    eventId,
  );

  await interaction.editReply({
    content: [
      `🔒 **${event.name}** (#${event.id}) is now closed for attendance.`,
      formatRefreshResult(refreshResult),
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
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

  await db
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
      ),
    );

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

  await db
    .update(events)
    .set({
      status: "cancelled",

      updatedAt: new Date(),
    })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.ownerGuildId, configuration.guildId),
      ),
    );

  const refreshResult = await refreshAttendanceMessage(
    interaction.guild,
    eventId,
  );

  await interaction.editReply({
    content: [
      `🚫 **${event.name}** (#${event.id}) has been cancelled.`,
      "Existing attendance responses have been retained.",
      formatRefreshResult(refreshResult),
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
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

  let event = await findOwnedEvent(configuration.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const now = new Date();

  /*
   * We do not have the scheduler yet. If an open event is already
   * beyond its deadline, an admin refresh can perform that overdue
   * transition before rebuilding the message.
   */
  if (
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

        startsAt: events.startsAt,

        attendanceClosesAt: events.attendanceClosesAt,
      });

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
        `The database record for **${event.name}** (#${event.id}) exists, but its Discord attendance message could not be refreshed.`,
        "",
        formatRefreshResult(refreshResult),
      ].join("\n"),
    );

    return;
  }

  await interaction.editReply({
    content: [
      `🔄 **${event.name}** (#${event.id}) was rebuilt from the database.`,
      `Attendance message: ${refreshResult.messageUrl}`,
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
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

      startsAt: events.startsAt,

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
