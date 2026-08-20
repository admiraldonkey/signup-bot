import { type ButtonInteraction, MessageFlags } from "discord.js";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { writeAuditLog } from "../audit/audit-log.js";
import { db } from "../db/client.js";
import {
  discordGuilds,
  eventOrganiserAssignments,
  events,
  guildSettings,
} from "../db/schema.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import {
  parseOrganiserCoverClaimCustomId,
  parseOrganiserResponseCustomId,
} from "../events/organiser-notification.js";
import {
  escalateAfterFailedOrganiserAssignment,
  type OrganiserEscalationResult,
} from "../organisers/organiser-escalation.js";
import { cancelOrganiserResponseActions } from "../organisers/organiser-scheduling.js";

export async function handleOrganiserButton(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const response = parseOrganiserResponseCustomId(interaction.customId);

  if (response) {
    await handleAssignmentResponse(interaction, response);

    return true;
  }

  const cover = parseOrganiserCoverClaimCustomId(interaction.customId);

  if (cover) {
    await handleCoverClaim(interaction, cover.eventId);

    return true;
  }

  return false;
}

async function handleAssignmentResponse(
  interaction: ButtonInteraction,
  parsed: {
    assignmentId: number;

    action: "confirm" | "decline";
  },
): Promise<void> {
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

      activatedAt: eventOrganiserAssignments.activatedAt,

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

    return;
  }

  if (interaction.user.id !== assignment.discordUserId) {
    await interaction.editReply(
      "This organiser confirmation belongs to another member.",
    );

    return;
  }

  if (!assignment.isCurrent) {
    await interaction.editReply(
      "This organiser assignment is no longer current.",
    );

    return;
  }

  if (!assignment.activatedAt) {
    await interaction.editReply(
      "This organiser assignment is currently on standby and is not awaiting a response.",
    );

    return;
  }

  if (assignment.status !== "pending") {
    await interaction.editReply(
      `You have already responded to this assignment: **${formatStatus(
        assignment.status,
      )}**.`,
    );

    return;
  }

  if (
    assignment.eventStatus === "cancelled" ||
    assignment.eventStatus === "completed"
  ) {
    await interaction.editReply(
      "This event is no longer accepting organiser responses.",
    );

    return;
  }

  const now = new Date();

  const updateValues =
    parsed.action === "confirm"
      ? {
          status: "confirmed" as const,

          respondedAt: now,

          updatedAt: now,
        }
      : {
          status: "declined" as const,

          isCurrent: false,

          respondedAt: now,

          endedAt: now,

          updatedAt: now,
        };

  const [updatedAssignment] = await db
    .update(eventOrganiserAssignments)
    .set(updateValues)
    .where(
      and(
        eq(eventOrganiserAssignments.id, assignment.id),

        eq(eventOrganiserAssignments.isCurrent, true),

        eq(eventOrganiserAssignments.status, "pending"),

        isNotNull(eventOrganiserAssignments.activatedAt),
      ),
    )
    .returning({
      id: eventOrganiserAssignments.id,
    });

  if (!updatedAssignment) {
    await interaction.editReply(
      "This organiser assignment changed before your response could be saved. Please check the current event status.",
    );

    return;
  }

  await cancelOrganiserResponseActions(assignment.eventId, assignment.id);

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

  let escalation: OrganiserEscalationResult | null = null;

  if (guild) {
    if (parsed.action === "confirm") {
      await refreshAttendanceMessage(guild, assignment.eventId).catch(
        (error: unknown) => {
          console.error(
            `Failed to refresh event ${assignment.eventId} after organiser confirmation:`,
            error,
          );
        },
      );
    } else {
      escalation = await escalateAfterFailedOrganiserAssignment({
        guild,

        eventId: assignment.eventId,

        failedAssignmentId: assignment.id,

        trigger: "declined",
      });
    }
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

      escalation: escalation?.kind ?? null,
    },
  });

  if (parsed.action === "confirm") {
    await interaction.editReply(
      `✅ You are confirmed as the organiser for **${assignment.eventName}**.`,
    );

    return;
  }

  await interaction.editReply(
    [
      `❌ You have declined the organiser assignment for **${assignment.eventName}**.`,

      "",

      formatEscalationResult(escalation),
    ].join("\n"),
  );
}

async function handleCoverClaim(
  interaction: ButtonInteraction,
  eventId: number,
): Promise<void> {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  if (!interaction.inCachedGuild()) {
    await interaction.editReply(
      "Event cover can only be claimed inside the event's Discord server.",
    );

    return;
  }

  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      status: events.status,

      startsAt: events.startsAt,

      guildDatabaseId: events.ownerGuildId,

      discordGuildId: discordGuilds.discordGuildId,

      eventOrganiserRoleId: guildSettings.eventOrganiserRoleId,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .leftJoin(guildSettings, eq(guildSettings.guildId, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event || event.discordGuildId !== interaction.guildId) {
    await interaction.editReply(
      "This cover request no longer belongs to an available event in this server.",
    );

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "This event no longer requires organiser cover.",
    );

    return;
  }

  if (event.startsAt <= new Date()) {
    await interaction.editReply(
      "This event has already started and can no longer be claimed through organiser cover.",
    );

    return;
  }

  if (!event.eventOrganiserRoleId) {
    await interaction.editReply(
      "This server does not currently have an Event Organiser role configured.",
    );

    return;
  }

  if (!interaction.member.roles.cache.has(event.eventOrganiserRoleId)) {
    await interaction.editReply(
      "Only members with the configured Event Organiser role can claim event cover.",
    );

    return;
  }

  const [activeAssignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, event.id),

        eq(eventOrganiserAssignments.isCurrent, true),

        isNotNull(eventOrganiserAssignments.activatedAt),

        inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
      ),
    )
    .limit(1);

  if (activeAssignment) {
    await interaction.editReply(
      "This event already has an active organiser assignment.",
    );

    return;
  }

  const now = new Date();

  const [coverAssignment] = await db
    .insert(eventOrganiserAssignments)
    .values({
      eventId: event.id,

      slot: "cover",

      discordUserId: interaction.user.id,

      displayNameSnapshot: interaction.member.displayName,

      status: "confirmed",

      isCurrent: true,

      assignedByUserId: interaction.user.id,

      activatedAt: now,

      responseDeadlineAt: null,

      respondedAt: now,

      updatedAt: now,
    })
    /*
     * The partial unique current-cover constraint makes concurrent
     * Claim Event presses race safely.
     */
    .onConflictDoNothing()
    .returning({
      id: eventOrganiserAssignments.id,
    });

  if (!coverAssignment) {
    await interaction.editReply(
      "Another organiser claimed this event before your response was saved.",
    );

    return;
  }

  /*
   * Defensive second check for a simultaneously-created primary or
   * backup assignment, which uses a different slot and therefore
   * would not collide with the cover unique constraint.
   */
  const [conflictingAssignment] = await db
    .select({
      id: eventOrganiserAssignments.id,
    })
    .from(eventOrganiserAssignments)
    .where(
      and(
        eq(eventOrganiserAssignments.eventId, event.id),

        ne(eventOrganiserAssignments.id, coverAssignment.id),

        eq(eventOrganiserAssignments.isCurrent, true),

        isNotNull(eventOrganiserAssignments.activatedAt),

        inArray(eventOrganiserAssignments.status, ["pending", "confirmed"]),
      ),
    )
    .limit(1);

  if (conflictingAssignment) {
    await db
      .update(eventOrganiserAssignments)
      .set({
        status: "replaced",

        isCurrent: false,

        endedAt: now,

        updatedAt: now,
      })
      .where(eq(eventOrganiserAssignments.id, coverAssignment.id));

    await interaction.editReply(
      "Another active organiser assignment was created while you were claiming cover, so your claim was not applied.",
    );

    return;
  }

  await interaction.message
    .edit({
      content: [
        interaction.message.content,

        "",

        `✅ **Cover claimed by <@${interaction.user.id}>.**`,
      ].join("\n"),

      components: [],

      allowedMentions: {
        parse: [],
      },
    })
    .catch((error: unknown) => {
      console.error(
        `Failed to update cover-request message for event ${event.id}:`,
        error,
      );
    });

  await refreshAttendanceMessage(interaction.guild, event.id);

  await writeAuditLog({
    guildId: event.guildDatabaseId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.organiser.cover.claim",

    outcome: "success",

    summary: `${interaction.member.displayName} claimed organiser cover for "${event.name}" (#${event.id}).`,

    targetType: "organiser_assignment",

    targetId: String(coverAssignment.id),

    details: {
      eventId: event.id,

      organiserUserId: interaction.user.id,
    },
  });

  await interaction.editReply(
    `✅ You are now the confirmed organiser for **${event.name}**.`,
  );
}

function formatEscalationResult(
  result: OrganiserEscalationResult | null,
): string {
  switch (result?.kind) {
    case "backup_activated":
      return "The backup organiser has now been contacted.";

    case "cover_queued":
      return "No standby backup was available, so an Event Organiser cover request has been queued.";

    case "already_resolved":
      return "Another active organiser assignment is already in place.";

    case "event_inactive":
      return "The event is no longer active, so no further escalation was performed.";

    default:
      return "No further organiser escalation could be performed automatically.";
  }
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
