import { type ChatInputCommandInteraction } from "discord.js";

import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { writeAuditLog } from "../audit/audit-log.js";
import { publishStoredEvent } from "../events/event-publication.js";
import { markEventPublicationCompleted } from "../scheduler/action-maintenance.js";

type CachedInteraction = ChatInputCommandInteraction<"cached">;

export async function publishEvent(
  interaction: CachedInteraction,
): Promise<void> {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply("This server has not been initialised.");

    return;
  }

  if (!configuration.enabled) {
    await interaction.editReply(
      "Event management is currently disabled for this server.",
    );

    return;
  }

  if (
    !memberCanManageEvents(interaction.member, configuration.eventAdminRoleId)
  ) {
    await interaction.editReply(
      "You need the configured Event Admin role or the Manage Server permission.",
    );

    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const result = await publishStoredEvent(interaction.guild, eventId);

  if (!result.ok) {
    switch (result.reason) {
      case "not-found":
        await interaction.editReply(
          `Event #${eventId} was not found in this server.`,
        );
        return;

      case "already-published":
        await interaction.editReply(
          `**${result.eventName ?? `Event #${eventId}`}** is already published.`,
        );
        return;

      case "inactive":
        await interaction.editReply(
          "Cancelled or completed events cannot be published.",
        );
        return;

      case "event-started":
        await interaction.editReply(
          "This event has already started and can no longer be published as an upcoming event.",
        );
        return;

      case "signup-closed":
        await interaction.editReply(
          [
            "This signup event can no longer be published because its signup deadline has already passed.",
            "",
            "Edit the event schedule or signup deadline before publishing it.",
          ].join("\n"),
        );
        return;
    }
  }

  /*
   * If this event had been scheduled for automatic publication,
   * a manual early publication makes that scheduled action obsolete.
   */
  await markEventPublicationCompleted(result.eventId);

  await writeAuditLog({
    guildId: configuration.guildId,

    guild: interaction.guild,

    actorUserId: interaction.user.id,

    action: "event.publish",

    outcome: "success",

    summary: `Published "${result.eventName}" (#${result.eventId}).`,

    targetType: "event",

    targetId: String(result.eventId),

    details: {
      messageUrl: result.messageUrl,

      primaryOrganiserNotification: result.primaryOrganiserNotification,
    },
  });

  const lines = [
    `📣 **${result.eventName}** (#${result.eventId}) has been published.`,
    "",
    `**Event message:** ${result.messageUrl}`,
  ];

  if (result.primaryOrganiserNotification === "dm") {
    lines.push("**Organiser confirmation:** DM sent");
  } else if (result.primaryOrganiserNotification === "admin_channel") {
    lines.push(
      "**Organiser confirmation:** DM failed; fallback posted in the Event Administration channel",
    );
  } else if (result.primaryOrganiserNotification === "failed") {
    lines.push(
      "**Organiser confirmation:** ⚠️ The assignment was activated, but its confirmation message could not be delivered",
    );
  }

  await interaction.editReply({
    content: lines.join("\n"),

    allowedMentions: {
      parse: [],
    },
  });
}
