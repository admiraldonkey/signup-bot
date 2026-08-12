import { type ButtonInteraction, MessageFlags } from "discord.js";
import { and, eq } from "drizzle-orm";

import { writeAuditLog } from "../audit/audit-log.js";
import { db } from "../db/client.js";
import {
  discordGuilds,
  eventOrganiserAssignments,
  events,
} from "../db/schema.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import { parseOrganiserResponseCustomId } from "../events/organiser-notification.js";

export async function handleOrganiserButton(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const parsed = parseOrganiserResponseCustomId(interaction.customId);

  if (!parsed) {
    return false;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const [assignment] = await db
    .select({
      id: eventOrganiserAssignments.id,

      eventId: eventOrganiserAssignments.eventId,

      slot: eventOrganiserAssignments.slot,

      discordUserId: eventOrganiserAssignments.discordUserId,

      status: eventOrganiserAssignments.status,

      isCurrent: eventOrganiserAssignments.isCurrent,

      eventName: events.name,

      eventStatus: events.status,

      guildDatabaseId: discordGuilds.id,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(eventOrganiserAssignments)
    .innerJoin(events, eq(events.id, eventOrganiserAssignments.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(eq(eventOrganiserAssignments.id, parsed.assignmentId))
    .limit(1);

  if (!assignment) {
    await interaction.editReply("This organiser assignment no longer exists.");

    return true;
  }

  /*
   * A copied button cannot be used by somebody else.
   */
  if (interaction.user.id !== assignment.discordUserId) {
    await interaction.editReply(
      "This organiser confirmation belongs to another member.",
    );

    return true;
  }

  if (!assignment.isCurrent) {
    await interaction.editReply(
      "This organiser assignment is no longer current.",
    );

    return true;
  }

  if (assignment.status !== "pending") {
    await interaction.editReply(
      `You have already responded to this assignment: **${formatStatus(
        assignment.status,
      )}**.`,
    );

    return true;
  }

  if (
    assignment.eventStatus === "cancelled" ||
    assignment.eventStatus === "completed"
  ) {
    await interaction.editReply(
      "This event is no longer accepting organiser responses.",
    );

    return true;
  }

  const newStatus = parsed.action === "confirm" ? "confirmed" : "declined";

  const now = new Date();

  /*
   * Include current/status checks in the UPDATE itself so two
   * nearly-simultaneous clicks cannot both succeed.
   */
  const [updatedAssignment] = await db
    .update(eventOrganiserAssignments)
    .set({
      status: newStatus,

      respondedAt: now,

      updatedAt: now,
    })
    .where(
      and(
        eq(eventOrganiserAssignments.id, assignment.id),

        eq(eventOrganiserAssignments.isCurrent, true),

        eq(eventOrganiserAssignments.status, "pending"),
      ),
    )
    .returning({
      id: eventOrganiserAssignments.id,
    });

  if (!updatedAssignment) {
    await interaction.editReply(
      "This organiser assignment changed before your response could be saved. Please check the current event status.",
    );

    return true;
  }

  /*
   * Remove the now-useless buttons from the DM/fallback message.
   * Failure here is cosmetic; the database is authoritative.
   */
  await interaction.message
    .edit({
      components: [],
    })
    .catch((error: unknown) => {
      console.error(
        `Failed to remove organiser buttons for assignment ${assignment.id}:`,
        error,
      );
    });

  let guild = null;

  try {
    guild = await interaction.client.guilds.fetch(assignment.discordGuildId);
  } catch (error) {
    console.error(
      `Failed to fetch guild ${assignment.discordGuildId} after organiser response:`,
      error,
    );
  }

  /*
   * Primary organiser status is visible on the public event post.
   *
   * Backup assignments are deliberately not public/active yet.
   */
  if (guild && assignment.slot === "primary") {
    await refreshAttendanceMessage(guild, assignment.eventId).catch(
      (error: unknown) => {
        console.error(
          `Failed to refresh event ${assignment.eventId} after organiser response:`,
          error,
        );
      },
    );
  }

  await writeAuditLog({
    guildId: assignment.guildDatabaseId,

    guild,

    actorUserId: interaction.user.id,

    action:
      parsed.action === "confirm"
        ? "event.organiser.confirm"
        : "event.organiser.decline",

    outcome: "success",

    summary:
      parsed.action === "confirm"
        ? `${interaction.user.username} confirmed organiser assignment #${assignment.id} for "${assignment.eventName}" (#${assignment.eventId}).`
        : `${interaction.user.username} declined organiser assignment #${assignment.id} for "${assignment.eventName}" (#${assignment.eventId}).`,

    targetType: "organiser_assignment",

    targetId: String(assignment.id),

    details: {
      eventId: assignment.eventId,

      slot: assignment.slot,

      organiserUserId: assignment.discordUserId,
    },
  });

  await interaction.editReply(
    parsed.action === "confirm"
      ? `✅ You are confirmed as the organiser for **${assignment.eventName}**.`
      : `❌ You have declined the organiser assignment for **${assignment.eventName}**.`,
  );

  return true;
}

function formatStatus(
  status:
    | "pending"
    | "confirmed"
    | "declined"
    | "timed_out"
    | "replaced"
    | "removed",
): string {
  switch (status) {
    case "pending":
      return "Awaiting confirmation";

    case "confirmed":
      return "Confirmed";

    case "declined":
      return "Declined";

    case "timed_out":
      return "Timed out";

    case "replaced":
      return "Replaced";

    case "removed":
      return "Removed";
  }
}
