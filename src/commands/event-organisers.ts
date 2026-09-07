import { type ChatInputCommandInteraction } from "discord.js";

import { writeAuditLog } from "../audit/audit-log.js";
import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import {
  type OrganiserNotificationDelivery,
  sendOrganiserAssignmentNotification,
} from "../events/organiser-notification.js";
import { reconcileOrganiserPendingWarning } from "../events/organiser-warning-reconciliation.js";
import {
  assignEventOrganiser,
  type EditableOrganiserSlot,
  removeEventOrganiserAssignment,
} from "../organisers/organiser-assignment-service.js";

type CachedInteraction = ChatInputCommandInteraction<"cached">;

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

  const result = await assignEventOrganiser({
    guildDatabaseId: context.guildId,

    eventId,

    slot,

    organiserUserId: user.id,

    displayNameSnapshot: member.displayName,

    assignedByUserId: interaction.user.id,

    primaryResponseMinutes: context.organiserPrimaryResponseMinutes,

    warningMinutesBefore: context.organiserWarningMinutesBefore,
  });

  switch (result.kind) {
    case "event_not_found":
      await interaction.editReply(
        `Event #${eventId} was not found in this server.`,
      );

      return;

    case "event_inactive":
      await interaction.editReply(
        "Organisers cannot be changed on cancelled or completed events.",
      );

      return;

    case "backup_requires_primary":
      await interaction.editReply(
        "Assign an active primary organiser before assigning a backup organiser.",
      );

      return;

    case "organiser_already_assigned_to_other_slot":
      await interaction.editReply(
        `That member is already the current **${result.otherSlot}** organiser. Clear that assignment first.`,
      );

      return;

    case "organiser_already_current":
      await interaction.editReply(
        `<@${user.id}> is already the current **${slot}** organiser for this event.`,
      );

      return;

    case "assigned":
      break;
  }

  const { event, assignment, replacedAssignmentIds } = result;

  /*
   * Replacement is already authoritative at this point. Discord warning
   * reconciliation is secondary presentation cleanup.
   */
  for (const replacedAssignmentId of replacedAssignmentIds) {
    await reconcileOrganiserPendingWarning({
      guild: interaction.guild,

      assignmentId: replacedAssignmentId,
    }).catch((error: unknown) => {
      console.error(
        `Failed to reconcile organiser warning for replaced assignment ${replacedAssignmentId}:`,
        error,
      );
    });
  }

  let notification: OrganiserNotificationDelivery | null = null;

  const activePrimary = slot === "primary" && assignment.activatedAt !== null;

  if (activePrimary) {
    try {
      notification = await sendOrganiserAssignmentNotification({
        guild: interaction.guild,

        assignmentId: assignment.id,

        eventId: event.id,

        eventName: event.name,

        discordUserId: user.id,

        slot: "primary",

        eventAdminChannelId: context.eventAdminChannelId,

        organiserDmsEnabled: context.organiserDmsEnabled,
      });
    } catch (error: unknown) {
      /*
       * The organiser assignment and response actions are already
       * authoritative. Notification failure cannot invalidate that state.
       */
      console.error(
        `Failed to deliver organiser assignment notification for assignment ${assignment.id}:`,
        error,
      );

      notification = "failed";
    }

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
    response.push(
      "",
      formatNotificationDelivery(notification, context.organiserDmsEnabled),
    );
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

  const result = await removeEventOrganiserAssignment({
    guildDatabaseId: context.guildId,
    eventId,
    slot,
  });

  switch (result.kind) {
    case "event_not_found":
      await interaction.editReply(
        `Event #${eventId} was not found in this server.`,
      );

      return;

    case "event_inactive":
      await interaction.editReply(
        "Organisers cannot be changed on cancelled or completed events.",
      );

      return;

    case "assignment_not_found":
      await interaction.editReply(
        `This event does not currently have a **${slot} organiser**.`,
      );

      return;

    case "removed":
      break;
  }

  const { event, assignment } = result;

  await reconcileOrganiserPendingWarning({
    guild: interaction.guild,
    assignmentId: assignment.id,
  }).catch((error: unknown) => {
    /*
     * The organiser removal is already authoritative. Failure to tidy an
     * older Discord warning must not undo or misreport that change.
     */
    console.error(
      `Failed to reconcile organiser warning for assignment ${assignment.id} after removal:`,
      error,
    );
  });

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

function formatNotificationDelivery(
  delivery: OrganiserNotificationDelivery | null,
  organiserDmsEnabled: boolean,
): string {
  switch (delivery) {
    case "dm":
      return "📨 Confirmation request sent by DM.";

    case "admin_channel":
      return organiserDmsEnabled
        ? "📨 The organiser could not be DMed, so a confirmation request was posted in the Event Administration channel."
        : "📨 Confirmation request posted in the Event Administration channel.";

    case "failed":
      return organiserDmsEnabled
        ? "⚠️ The assignment was saved, but the bot could not deliver the confirmation request by DM or through the Event Administration channel."
        : "⚠️ The assignment was saved, but the bot could not deliver the confirmation request through the Event Administration channel.";

    case null:
      return "No confirmation request was sent.";
  }
}
