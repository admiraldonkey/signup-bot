import { type ChatInputCommandInteraction } from "discord.js";
import { and, eq } from "drizzle-orm";

import { writeAuditLog } from "../audit/audit-log.js";
import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import { eventOrganiserAssignments, events } from "../db/schema.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import {
  type OrganiserNotificationDelivery,
  sendOrganiserAssignmentNotification,
} from "../events/organiser-notification.js";

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

  /*
   * A backup without a primary has no meaningful relationship to
   * anything yet.
   */
  if (slot === "backup") {
    const currentPrimary = await findCurrentAssignment(event.id, "primary");

    if (!currentPrimary) {
      await interaction.editReply(
        "Assign a primary organiser before assigning a backup organiser.",
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

    return created;
  });

  let notification: OrganiserNotificationDelivery | null = null;

  /*
   * Primary organisers are contacted immediately.
   *
   * Backups remain dormant until the escalation system activates
   * them in the next phase.
   */
  if (slot === "primary") {
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
      "The backup has been stored on standby and has not been contacted yet.",
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

  if (slot === "primary") {
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
