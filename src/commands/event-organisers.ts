import { type ChatInputCommandInteraction } from "discord.js";
import { and, eq, inArray, isNotNull, like, or } from "drizzle-orm";

import { writeAuditLog } from "../audit/audit-log.js";
import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import {
  eventOrganiserAssignments,
  events,
  scheduledActions,
} from "../db/schema.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import {
  type OrganiserNotificationDelivery,
  sendOrganiserAssignmentNotification,
} from "../events/organiser-notification.js";
import {
  buildOrganiserResponseActionValues,
  calculateOrganiserResponseDeadline,
  cancelOrganiserResponseActions,
  ORGANISER_COVER_REQUEST_ACTION_PREFIX,
  ORGANISER_TIMEOUT_ACTION_PREFIX,
  ORGANISER_WARNING_ACTION_PREFIX,
} from "../organisers/organiser-scheduling.js";

type CachedInteraction = ChatInputCommandInteraction<"cached">;

type EditableOrganiserSlot = "primary" | "backup";

export async function setEventOrganiser(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getOrganiserContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const slotText = interaction.options.getString("slot", true);

  if (slotText !== "primary" && slotText !== "backup") {
    await interaction.editReply("The organiser slot is invalid.");

    return;
  }

  const slot: EditableOrganiserSlot = slotText;

  const user = interaction.options.getUser("user", true);

  if (user.bot) {
    await interaction.editReply(
      "Bot accounts cannot be assigned as event organisers.",
    );

    return;
  }

  const event = await findOwnedEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "Organisers cannot be changed on cancelled or completed events.",
    );

    return;
  }

  let member;

  try {
    member = await interaction.guild.members.fetch(user.id);
  } catch {
    await interaction.editReply(
      "That user could not be resolved as a current member of this server.",
    );

    return;
  }

  if (
    context.eventOrganiserRoleId &&
    !member.roles.cache.has(context.eventOrganiserRoleId)
  ) {
    await interaction.editReply(
      "That member does not have the configured Event Organiser role.",
    );

    return;
  }

  if (slot === "backup") {
    const currentPrimary = await findCurrentAssignment(event.id, "primary");

    if (
      !currentPrimary ||
      !["pending", "confirmed"].includes(currentPrimary.status)
    ) {
      await interaction.editReply(
        "Assign an active primary organiser before assigning a backup organiser.",
      );

      return;
    }
  }

  const otherSlot: EditableOrganiserSlot =
    slot === "primary" ? "backup" : "primary";

  const otherAssignment = await findCurrentAssignment(event.id, otherSlot);

  if (otherAssignment?.discordUserId === user.id) {
    await interaction.editReply(
      `That member is already the current **${otherSlot}** organiser. Clear that assignment first.`,
    );

    return;
  }

  const existing = await findCurrentAssignment(event.id, slot);

  if (
    existing?.discordUserId === user.id &&
    (existing.status === "pending" || existing.status === "confirmed")
  ) {
    await interaction.editReply(
      `<@${user.id}> is already the current **${slot}** organiser for this event.`,
    );

    return;
  }

  const now = new Date();

  const shouldActivatePrimary =
    slot === "primary" && event.publishedAt !== null;

  const assignment = await db.transaction(async (transaction) => {
    if (existing) {
      await transaction
        .update(eventOrganiserAssignments)
        .set({
          status: "replaced",

          isCurrent: false,

          endedAt: now,

          updatedAt: now,
        })
        .where(eq(eventOrganiserAssignments.id, existing.id));
    }

    /*
     * A newly assigned primary supersedes any currently-active
     * backup or cover organiser.
     *
     * Dormant backups are deliberately retained.
     */
    if (slot === "primary") {
      await transaction
        .update(eventOrganiserAssignments)
        .set({
          status: "replaced",

          isCurrent: false,

          endedAt: now,

          updatedAt: now,
        })
        .where(
          and(
            eq(eventOrganiserAssignments.eventId, event.id),

            eq(eventOrganiserAssignments.isCurrent, true),

            isNotNull(eventOrganiserAssignments.activatedAt),

            inArray(eventOrganiserAssignments.slot, ["backup", "cover"]),
          ),
        );

      /*
       * Cancel old organiser escalation work, including a cover
       * request which may have just become unnecessary.
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
            eq(scheduledActions.eventId, event.id),

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

    const activatedAt = shouldActivatePrimary ? now : null;

    const responseDeadlineAt = shouldActivatePrimary
      ? calculateOrganiserResponseDeadline(
          now,
          context.organiserPrimaryResponseMinutes,
        )
      : null;

    const [created] = await transaction
      .insert(eventOrganiserAssignments)
      .values({
        eventId: event.id,

        slot,

        discordUserId: user.id,

        displayNameSnapshot: member.displayName,

        status: "pending",

        isCurrent: true,

        assignedByUserId: interaction.user.id,

        activatedAt,

        responseDeadlineAt,

        updatedAt: now,
      })
      .returning({
        id: eventOrganiserAssignments.id,
      });

    if (!created) {
      throw new Error(
        "The organiser assignment was not returned by the database.",
      );
    }

    if (shouldActivatePrimary) {
      if (!activatedAt || !responseDeadlineAt) {
        throw new Error(
          "The primary organiser activation times were not created.",
        );
      }

      const actions = buildOrganiserResponseActionValues({
        eventId: event.id,

        assignmentId: created.id,

        activatedAt,

        responseDeadlineAt,

        warningMinutesBefore: context.organiserWarningMinutesBefore,
      });

      await transaction.insert(scheduledActions).values(actions);
    }

    return created;
  });

  let notification: OrganiserNotificationDelivery | null = null;

  if (shouldActivatePrimary) {
    notification = await sendOrganiserAssignmentNotification({
      guild: interaction.guild,

      assignmentId: assignment.id,

      eventId: event.id,

      eventName: event.name,

      discordUserId: user.id,

      slot: "primary",

      eventAdminChannelId: context.eventAdminChannelId,
    });

    await refreshAttendanceMessage(interaction.guild, event.id);
  }

  await writeAuditLog({
    guildId: context.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.organiser.set",

    outcome: "success",

    summary: `Assigned ${member.displayName} as ${slot} organiser for "${event.name}" (#${event.id}).`,

    targetType: "organiser_assignment",

    targetId: String(assignment.id),

    details: {
      eventId: event.id,

      slot,

      organiserUserId: user.id,

      notification,
    },
  });

  const response = [
    `✅ <@${user.id}> is now the **${slot} organiser** for **${event.name}** (#${event.id}).`,
  ];

  if (slot === "backup") {
    response.push(
      "",
      "The backup has been stored on standby and will only be contacted if the primary becomes unavailable.",
    );
  } else {
    response.push("", formatNotificationDelivery(notification));
  }

  await interaction.editReply({
    content: response.join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}

export async function clearEventOrganiser(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getOrganiserContext(interaction);

  if (!context) {
    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const slotText = interaction.options.getString("slot", true);

  if (slotText !== "primary" && slotText !== "backup") {
    await interaction.editReply("The organiser slot is invalid.");

    return;
  }

  const slot: EditableOrganiserSlot = slotText;

  const event = await findOwnedEvent(context.guildId, eventId);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "Organisers cannot be changed on cancelled or completed events.",
    );

    return;
  }

  const assignment = await findCurrentAssignment(event.id, slot);

  if (!assignment) {
    await interaction.editReply(
      `This event does not currently have a **${slot} organiser**.`,
    );

    return;
  }

  const now = new Date();

  await db
    .update(eventOrganiserAssignments)
    .set({
      status: "removed",

      isCurrent: false,

      endedAt: now,

      updatedAt: now,
    })
    .where(
      and(
        eq(eventOrganiserAssignments.id, assignment.id),

        eq(eventOrganiserAssignments.isCurrent, true),
      ),
    );

  await cancelOrganiserResponseActions(event.id, assignment.id);

  if (assignment.activatedAt) {
    await refreshAttendanceMessage(interaction.guild, event.id);
  }

  await writeAuditLog({
    guildId: context.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.organiser.clear",

    outcome: "success",

    summary: `Removed the current ${slot} organiser from "${event.name}" (#${event.id}).`,

    targetType: "organiser_assignment",

    targetId: String(assignment.id),

    details: {
      eventId: event.id,

      slot,

      organiserUserId: assignment.discordUserId,
    },
  });

  await interaction.editReply({
    content: `✅ The **${slot} organiser** has been cleared from **${event.name}** (#${event.id}).`,

    allowedMentions: {
      parse: [],
    },
  });
}

async function getOrganiserContext(interaction: CachedInteraction) {
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
      publishedAt: events.publishedAt,
    })
    .from(events)
    .where(
      and(
        eq(events.id, eventId),

        eq(events.ownerGuildId, guildDatabaseId),
      ),
    )
    .limit(1);

  return event ?? null;
}

async function findCurrentAssignment(
  eventId: number,
  slot: EditableOrganiserSlot,
) {
  const [assignment] = await db
    .select({
      id: eventOrganiserAssignments.id,

      discordUserId: eventOrganiserAssignments.discordUserId,

      status: eventOrganiserAssignments.status,

      activatedAt: eventOrganiserAssignments.activatedAt,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, eventId),

        eq(eventOrganiserAssignments.slot, slot),

        eq(eventOrganiserAssignments.isCurrent, true),
      ),
    )
    .limit(1);

  return assignment ?? null;
}

function formatNotificationDelivery(
  delivery: OrganiserNotificationDelivery | null,
): string {
  switch (delivery) {
    case "dm":
      return "📨 Confirmation request sent by DM.";

    case "admin_channel":
      return "📨 The organiser could not be DMed, so a confirmation request was posted in the Event Administration channel.";

    case "failed":
      return "⚠️ The assignment was saved, but the bot could not deliver the confirmation request by DM or through the Event Administration channel.";

    case null:
      return "No confirmation request was sent.";
  }
}
