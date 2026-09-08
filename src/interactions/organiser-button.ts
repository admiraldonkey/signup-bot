import { type ButtonInteraction, MessageFlags } from "discord.js";

import { writeAuditLog } from "../audit/audit-log.js";
import { refreshAttendanceMessage } from "../events/attendance-refresh.js";
import {
  parseOrganiserCoverClaimCustomId,
  parseOrganiserResponseCustomId,
} from "../events/organiser-notification.js";
import { reconcileOrganiserPendingWarning } from "../events/organiser-warning-reconciliation.js";
import {
  claimEventOrganiserCover,
  getOrganiserCoverClaimContext,
} from "../organisers/organiser-cover-service.js";
import {
  escalateAfterFailedOrganiserAssignment,
  type OrganiserEscalationResult,
} from "../organisers/organiser-escalation.js";
import { recordOrganiserResponse } from "../organisers/organiser-response-service.js";
import type { OrganiserAssignmentStatus } from "../organisers/organiser-types.js";

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

  const result = await recordOrganiserResponse({
    assignmentId: parsed.assignmentId,

    respondingUserId: interaction.user.id,

    action: parsed.action,
  });

  switch (result.kind) {
    case "assignment_not_found":
      await interaction.editReply(
        "This organiser assignment no longer exists.",
      );

      return;

    case "wrong_user":
      await interaction.editReply(
        "This organiser confirmation belongs to another member.",
      );

      return;

    case "assignment_not_current":
      await interaction.editReply(
        "This organiser assignment is no longer current.",
      );

      return;

    case "assignment_standby":
      await interaction.editReply(
        "This organiser assignment is currently on standby and is not awaiting a response.",
      );

      return;

    case "already_responded":
      await interaction.editReply(
        `You have already responded to this assignment: **${formatStatus(
          result.status,
        )}**.`,
      );

      return;

    case "organisers_disabled":
      await interaction.editReply(
        "Event organiser responses are currently disabled for this server.",
      );

      return;

    case "event_inactive":
      await interaction.editReply(
        "This event is no longer accepting organiser responses.",
      );

      return;

    case "assignment_changed":
      await interaction.editReply(
        "This organiser assignment changed before your response could be saved. Please check the current event status.",
      );

      return;

    case "saved":
      break;
  }

  const { assignment } = result;

  await interaction.message
    .edit({
      components: [],
    })
    .catch((error: unknown) => {
      /*
       * The organiser response is already authoritative. Failing to remove
       * stale Discord buttons cannot undo that database state.
       */
      console.error(
        `Failed to remove organiser buttons for assignment ${assignment.id}:`,
        error,
      );
    });

  let guild = null;

  try {
    guild = await interaction.client.guilds.fetch(assignment.discordGuildId);
  } catch (error: unknown) {
    console.error(
      `Failed to fetch guild ${assignment.discordGuildId} after organiser response:`,
      error,
    );
  }

  let escalation: OrganiserEscalationResult | null = null;

  if (guild) {
    await reconcileOrganiserPendingWarning({
      guild,

      assignmentId: assignment.id,
    }).catch((error: unknown) => {
      /*
       * The organiser response is already authoritative. Failure to tidy an
       * older Discord warning must not undo or misreport that response.
       */
      console.error(
        `Failed to reconcile organiser warning for assignment ${assignment.id}:`,
        error,
      );
    });

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

  const context = await getOrganiserCoverClaimContext({
    eventId,

    discordGuildId: interaction.guildId,
  });

  switch (context.kind) {
    case "event_unavailable":
      await interaction.editReply(
        "This cover request no longer belongs to an available event in this server.",
      );

      return;

    case "organisers_disabled":
      await interaction.editReply(
        "Event organisers are currently disabled for this server.",
      );

      return;

    case "event_inactive":
      await interaction.editReply(
        "This event no longer requires organiser cover.",
      );

      return;

    case "role_not_configured":
      await interaction.editReply(
        "This server does not currently have an Event Organiser role configured.",
      );

      return;

    case "eligible":
      break;
  }

  const { event } = context;

  if (!interaction.member.roles.cache.has(event.eventOrganiserRoleId)) {
    await interaction.editReply(
      "Only members with the configured Event Organiser role can claim event cover.",
    );

    return;
  }

  const claimResult = await claimEventOrganiserCover({
    eventId: event.id,

    organiserUserId: interaction.user.id,

    displayNameSnapshot: interaction.member.displayName,
  });

  switch (claimResult.kind) {
    case "organisers_disabled":
      await interaction.editReply(
        "Event organisers were disabled before your cover claim could be saved.",
      );

      return;

    case "event_inactive":
      await interaction.editReply(
        "This event no longer requires organiser cover.",
      );

      return;

    case "active_assignment":
      await interaction.editReply(
        "This event already has an active organiser assignment.",
      );

      return;

    case "cover_taken":
      await interaction.editReply(
        "Another organiser claimed this event before your response was saved.",
      );

      return;

    case "ownership_lost":
      await interaction.editReply(
        "Another active organiser assignment was created while you were claiming cover, so your claim was not applied.",
      );

      return;

    case "claimed":
      break;
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
      /*
       * Organiser ownership is already authoritative. Failure to update the
       * cover-request message cannot invalidate the successful claim.
       */
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

    targetId: String(claimResult.assignmentId),

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

    case "organisers_disabled":
      return "Event organisers have been disabled for this server, so no further escalation was performed.";

    case "event_inactive":
      return "The event is no longer active, so no further escalation was performed.";

    default:
      return "No further organiser escalation could be performed automatically.";
  }
}

function formatStatus(status: OrganiserAssignmentStatus): string {
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
