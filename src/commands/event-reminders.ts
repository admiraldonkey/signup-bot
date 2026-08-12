import { type ChatInputCommandInteraction } from "discord.js";
import { and, asc, eq, inArray } from "drizzle-orm";

import { writeAuditLog } from "../audit/audit-log.js";
import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import {
  eventMessages,
  eventReminders,
  events,
  scheduledActions,
} from "../db/schema.js";
import {
  sendEventCustomMessage,
  validateEventMessageDestination,
} from "../events/event-custom-message.js";
import {
  buildReminderActionKey,
  calculateReminderDueAt,
  type ReminderTimingReference,
} from "../reminders/reminder-scheduling.js";

type CachedInteraction = ChatInputCommandInteraction<"cached">;

export async function addEventReminder(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getReminderContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "Reminders cannot be added to a cancelled or completed event.",
    );

    return;
  }

  const timingReference = interaction.options.getString("relative-to", true);

  if (timingReference !== "signup_close" && timingReference !== "event_start") {
    await interaction.editReply("The reminder timing reference is invalid.");

    return;
  }

  const minutesBefore = interaction.options.getInteger("minutes-before", true);

  const message = interaction.options.getString("message", true).trim();

  if (!message) {
    await interaction.editReply("The reminder message cannot be empty.");

    return;
  }

  const selectedChannel = interaction.options.getChannel("channel");

  const channelId = selectedChannel?.id ?? event.attendanceChannelId;

  const pingEventRoles =
    interaction.options.getBoolean("ping-event-roles") ?? true;

  const dueAt = calculateReminderDueAt(timingReference, minutesBefore, event);

  if (!dueAt) {
    await interaction.editReply(
      "That event does not have the required reference time.",
    );

    return;
  }

  if (dueAt <= new Date()) {
    const unix = Math.floor(dueAt.getTime() / 1000);

    await interaction.editReply(
      [
        "That reminder would already be due.",
        "",
        `Calculated time: <t:${unix}:F>`,
        "",
        "Choose a later event/reference point or fewer minutes before it.",
      ].join("\n"),
    );

    return;
  }

  try {
    await validateEventMessageDestination(
      interaction.guild,
      event.id,
      channelId,
      pingEventRoles,
    );
  } catch (error) {
    await interaction.editReply(
      error instanceof Error
        ? error.message
        : "The reminder destination could not be validated.",
    );

    return;
  }

  const now = new Date();

  const reminder = await db.transaction(async (transaction) => {
    const [createdReminder] = await transaction
      .insert(eventReminders)
      .values({
        eventId: event.id,

        timingReference,

        minutesBefore,

        message,

        channelId,

        pingEventRoles,

        enabled: true,

        createdByUserId: interaction.user.id,

        updatedAt: now,
      })
      .returning({
        id: eventReminders.id,
      });

    if (!createdReminder) {
      throw new Error("The reminder could not be created.");
    }

    await transaction.insert(scheduledActions).values({
      eventId: event.id,

      actionKey: buildReminderActionKey(createdReminder.id),

      dueAt,

      status: "pending",

      attemptCount: 0,

      updatedAt: now,
    });

    return createdReminder;
  });

  await writeAuditLog({
    guildId: context.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.reminder.add",

    outcome: "success",

    summary: `Added reminder #${reminder.id} to "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),

    details: {
      reminderId: reminder.id,

      timingReference,

      minutesBefore,

      dueAt: dueAt.toISOString(),

      channelId,

      pingEventRoles,
    },
  });

  const unix = Math.floor(dueAt.getTime() / 1000);

  await interaction.editReply({
    content: [
      `✅ Reminder **#${reminder.id}** added to **${event.name}**.`,
      "",
      `**Sends:** <t:${unix}:F> (<t:${unix}:R>)`,
      `**Relative to:** ${formatTimingReference(timingReference)}`,
      `**Destination:** <#${channelId}>`,
      `**Ping event roles:** ${pingEventRoles ? "Yes" : "No"}`,
      "",
      `**Message:** ${message}`,
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

export async function listEventReminders(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getReminderContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const reminders = await db
    .select()
    .from(eventReminders)
    .where(eq(eventReminders.eventId, event.id))
    .orderBy(asc(eventReminders.id));

  if (reminders.length === 0) {
    await interaction.editReply(
      `No reminders have been configured for **${event.name}**.`,
    );

    return;
  }

  const actions = await db
    .select({
      actionKey: scheduledActions.actionKey,

      dueAt: scheduledActions.dueAt,

      status: scheduledActions.status,
    })
    .from(scheduledActions)
    .where(eq(scheduledActions.eventId, event.id));

  const actionByKey = new Map(
    actions.map((action) => [action.actionKey, action]),
  );

  const lines = reminders.slice(0, 20).map((reminder) => {
    const action = actionByKey.get(buildReminderActionKey(reminder.id));

    const status = reminder.sentAt
      ? "Sent"
      : reminder.missedAt
        ? "Missed"
        : !reminder.enabled
          ? "Removed"
          : (action?.status ?? "Unknown");

    const due = action
      ? `<t:${Math.floor(action.dueAt.getTime() / 1000)}:f>`
      : "No scheduled action";

    return [
      `**#${reminder.id} — ${status}**`,
      reminder.missedReason ? `Reason: ${reminder.missedReason}` : null,
      `${formatTimingReference(
        reminder.timingReference,
      )}, ${reminder.minutesBefore} minute(s) before`,
      `Sends: ${due}`,
      `Channel: <#${reminder.channelId}> • Ping roles: ${reminder.pingEventRoles ? "Yes" : "No"}`,
      `Message: ${truncate(reminder.message, 180)}`,
    ].join("\n");
  });

  await interaction.editReply({
    content: [
      `**Reminders — ${event.name} (#${event.id})**`,
      "",
      ...lines,
      reminders.length > 20
        ? `\n+ ${reminders.length - 20} more reminder(s)`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

export async function removeEventReminder(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getReminderContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const reminderId = interaction.options.getInteger("reminder-id", true);

  const event = await findOwnedEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const [reminder] = await db
    .select()
    .from(eventReminders)
    .where(
      and(
        eq(eventReminders.id, reminderId),

        eq(eventReminders.eventId, event.id),
      ),
    )
    .limit(1);

  if (!reminder) {
    await interaction.editReply(
      `Reminder #${reminderId} was not found on this event.`,
    );

    return;
  }

  if (reminder.sentAt) {
    await interaction.editReply(
      "That reminder has already been sent and cannot be removed.",
    );

    return;
  }

  if (!reminder.enabled) {
    await interaction.editReply("That reminder has already been removed.");

    return;
  }

  const now = new Date();

  await db.transaction(async (transaction) => {
    await transaction
      .update(eventReminders)
      .set({
        enabled: false,

        updatedAt: now,
      })
      .where(eq(eventReminders.id, reminder.id));

    await transaction
      .update(scheduledActions)
      .set({
        status: "cancelled",

        lockedAt: null,

        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledActions.eventId, event.id),

          eq(scheduledActions.actionKey, buildReminderActionKey(reminder.id)),

          inArray(scheduledActions.status, ["pending", "processing"]),
        ),
      );
  });

  await writeAuditLog({
    guildId: context.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.reminder.remove",

    outcome: "success",

    summary: `Removed reminder #${reminder.id} from "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),

    details: {
      reminderId: reminder.id,
    },
  });

  await interaction.editReply(
    `✅ Reminder **#${reminder.id}** has been removed from **${event.name}**.`,
  );
}

export async function announceEvent(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getReminderContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const event = await findOwnedEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  const message = interaction.options.getString("message", true).trim();

  if (!message) {
    await interaction.editReply("The announcement cannot be empty.");

    return;
  }

  const selectedChannel = interaction.options.getChannel("channel");

  const channelId = selectedChannel?.id ?? event.attendanceChannelId;

  /*
   * Announcements default to NOT pinging anyone.
   * Accidental mass notifications are rarely improved by optimism.
   */
  const pingEventRoles =
    interaction.options.getBoolean("ping-event-roles") ?? false;

  let sentMessage;

  try {
    sentMessage = await sendEventCustomMessage({
      guild: interaction.guild,

      eventId: event.id,

      eventName: event.name,

      channelId,

      message,

      pingEventRoles,

      hideMentions: true,
    });
  } catch (error) {
    await interaction.editReply(
      error instanceof Error
        ? error.message
        : "The announcement could not be sent.",
    );

    return;
  }

  await writeAuditLog({
    guildId: context.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.announce",

    outcome: "success",

    summary: `Sent an announcement for "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),

    details: {
      channelId: sentMessage.channelId,

      messageId: sentMessage.messageId,

      pingEventRoles,
    },
  });

  await interaction.editReply(
    ["✅ Event announcement sent.", "", sentMessage.url].join("\n"),
  );
}

async function getReminderContext(interaction: CachedInteraction) {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply("This server has not been initialised.");

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
      "You need the configured Event Admin role or the Manage Server permission.",
    );

    return null;
  }

  return configuration;
}

async function findOwnedEvent(guildDatabaseId: number, eventId: number) {
  const [event] = await db
    .select({
      id: events.id,
      name: events.name,
      status: events.status,
      startsAt: events.startsAt,
      attendanceClosesAt: events.attendanceClosesAt,
      attendanceChannelId: eventMessages.channelId,
    })
    .from(events)
    .innerJoin(
      eventMessages,
      and(
        eq(eventMessages.eventId, events.id),

        eq(eventMessages.kind, "attendance"),

        eq(eventMessages.guildId, guildDatabaseId),
      ),
    )
    .where(
      and(
        eq(events.id, eventId),

        eq(events.ownerGuildId, guildDatabaseId),
      ),
    )
    .limit(1);

  return event ?? null;
}

function formatTimingReference(timingReference: string): string {
  switch (timingReference) {
    case "signup_close":
      return "Signup close";

    case "event_start":
      return "Event start";

    default:
      return timingReference;
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength - 1) + "…";
}

export async function editEventReminder(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getReminderContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const reminderId = interaction.options.getInteger("reminder-id", true);

  const event = await findOwnedEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "Reminders on cancelled or completed events cannot be edited.",
    );

    return;
  }

  const [reminder] = await db
    .select({
      id: eventReminders.id,

      eventId: eventReminders.eventId,

      timingReference: eventReminders.timingReference,

      minutesBefore: eventReminders.minutesBefore,

      message: eventReminders.message,

      channelId: eventReminders.channelId,

      pingEventRoles: eventReminders.pingEventRoles,

      enabled: eventReminders.enabled,

      sentAt: eventReminders.sentAt,

      missedAt: eventReminders.missedAt,
    })
    .from(eventReminders)
    .where(
      and(
        eq(eventReminders.id, reminderId),

        eq(eventReminders.eventId, event.id),
      ),
    )
    .limit(1);

  if (!reminder) {
    await interaction.editReply(
      `Reminder #${reminderId} was not found on this event.`,
    );

    return;
  }

  if (!reminder.enabled) {
    await interaction.editReply(
      "That reminder has already been removed and cannot be edited.",
    );

    return;
  }

  if (reminder.sentAt) {
    await interaction.editReply(
      [
        "That reminder has already been sent, so it cannot be edited.",
        "",
        "Use `/event announce` if a correction or follow-up message is required.",
      ].join("\n"),
    );

    return;
  }

  if (reminder.missedAt) {
    await interaction.editReply(
      [
        "That reminder was already marked as missed and cannot be edited.",
        "",
        "Use `/event reminder-add` to schedule a replacement, or `/event announce` to send a message immediately.",
      ].join("\n"),
    );

    return;
  }

  const timingReferenceOption = interaction.options.getString("relative-to");

  const minutesBeforeOption = interaction.options.getInteger("minutes-before");

  const messageOptionRaw = interaction.options.getString("message");

  const selectedChannel = interaction.options.getChannel("channel");

  const pingEventRolesOption =
    interaction.options.getBoolean("ping-event-roles");

  const anyChangeRequested =
    timingReferenceOption !== null ||
    minutesBeforeOption !== null ||
    messageOptionRaw !== null ||
    selectedChannel !== null ||
    pingEventRolesOption !== null;

  if (!anyChangeRequested) {
    await interaction.editReply("No reminder changes were supplied.");

    return;
  }

  const newTimingReference = timingReferenceOption ?? reminder.timingReference;

  if (
    newTimingReference !== "signup_close" &&
    newTimingReference !== "event_start"
  ) {
    await interaction.editReply("The reminder timing reference is invalid.");

    return;
  }

  const newMinutesBefore = minutesBeforeOption ?? reminder.minutesBefore;

  const newMessage =
    messageOptionRaw !== null ? messageOptionRaw.trim() : reminder.message;

  if (!newMessage) {
    await interaction.editReply("The reminder message cannot be empty.");

    return;
  }

  const newChannelId = selectedChannel?.id ?? reminder.channelId;

  const newPingEventRoles = pingEventRolesOption ?? reminder.pingEventRoles;

  const newDueAt = calculateReminderDueAt(
    newTimingReference,
    newMinutesBefore,
    event,
  );

  if (!newDueAt) {
    await interaction.editReply(
      "That event does not have the required reference time.",
    );

    return;
  }

  if (newDueAt <= new Date()) {
    const unix = Math.floor(newDueAt.getTime() / 1000);

    await interaction.editReply(
      [
        "The edited reminder would already be due.",
        "",
        `Calculated time: <t:${unix}:F>`,
        "",
        "Choose a later timing or use `/event announce` to send a message immediately.",
      ].join("\n"),
    );

    return;
  }

  try {
    await validateEventMessageDestination(
      interaction.guild,
      event.id,
      newChannelId,
      newPingEventRoles,
    );
  } catch (error) {
    await interaction.editReply(
      error instanceof Error
        ? error.message
        : "The reminder destination could not be validated.",
    );

    return;
  }

  const now = new Date();

  await db.transaction(async (transaction) => {
    await transaction
      .update(eventReminders)
      .set({
        timingReference: newTimingReference,

        minutesBefore: newMinutesBefore,

        message: newMessage,

        channelId: newChannelId,

        pingEventRoles: newPingEventRoles,

        updatedAt: now,
      })
      .where(eq(eventReminders.id, reminder.id));

    /*
     * Reset/recreate the corresponding scheduler action using
     * the newly-calculated time.
     */
    await transaction
      .insert(scheduledActions)
      .values({
        eventId: event.id,

        actionKey: buildReminderActionKey(reminder.id),

        dueAt: newDueAt,

        status: "pending",

        attemptCount: 0,

        lockedAt: null,

        completedAt: null,

        lastError: null,

        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [scheduledActions.eventId, scheduledActions.actionKey],

        set: {
          dueAt: newDueAt,

          status: "pending",

          attemptCount: 0,

          lockedAt: null,

          completedAt: null,

          lastError: null,

          updatedAt: now,
        },
      });
  });

  await writeAuditLog({
    guildId: context.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.reminder.edit",

    outcome: "success",

    summary: `Edited reminder #${reminder.id} for "${event.name}" (#${event.id}).`,

    targetType: "event",

    targetId: String(event.id),

    details: {
      reminderId: reminder.id,

      timingReference: newTimingReference,

      minutesBefore: newMinutesBefore,

      dueAt: newDueAt.toISOString(),

      channelId: newChannelId,

      pingEventRoles: newPingEventRoles,

      messageChanged: messageOptionRaw !== null,
    },
  });

  const unix = Math.floor(newDueAt.getTime() / 1000);

  await interaction.editReply({
    content: [
      `✅ Reminder **#${reminder.id}** updated for **${event.name}**.`,
      "",
      `**Sends:** <t:${unix}:F> (<t:${unix}:R>)`,
      `**Relative to:** ${formatTimingReference(newTimingReference)}`,
      `**Minutes before:** ${newMinutesBefore}`,
      `**Destination:** <#${newChannelId}>`,
      `**Ping event roles:** ${newPingEventRoles ? "Yes" : "No"}`,
      "",
      `**Message:** ${newMessage}`,
    ].join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}
