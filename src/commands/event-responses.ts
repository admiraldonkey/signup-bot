import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { and, eq } from "drizzle-orm";

import { formatUserMentions } from "../attendance/format.js";
import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import { attendanceResponses, events } from "../db/schema.js";

export async function handleEventResponses(
  interaction: ChatInputCommandInteraction<"cached">,
): Promise<void> {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply("This server has not been initialised.");

    return;
  }

  if (
    !memberCanManageEvents(interaction.member, configuration.eventAdminRoleId)
  ) {
    await interaction.editReply(
      "You need the configured Event Admin role " +
        "or the Manage Server permission to view event responses.",
    );

    return;
  }

  const eventId = interaction.options.getInteger("event-id", true);

  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      signupsEnabled: events.signupsEnabled,
    })
    .from(events)
    .where(
      and(
        eq(events.id, eventId),
        eq(events.ownerGuildId, configuration.guildId),
      ),
    )
    .limit(1);

  if (!event) {
    await interaction.editReply(
      `Event #${eventId} was not found in this server.`,
    );

    return;
  }

  if (!event.signupsEnabled) {
    await interaction.editReply(
      "Attendance signups are disabled for this event.",
    );

    return;
  }

  const responses = await db
    .select({
      userId: attendanceResponses.discordUserId,

      status: attendanceResponses.status,
    })
    .from(attendanceResponses)
    .where(eq(attendanceResponses.eventId, eventId));

  const attending = responses
    .filter((response) => response.status === "attending")
    .map((response) => response.userId);

  const tentative = responses
    .filter((response) => response.status === "tentative")
    .map((response) => response.userId);

  const notAttending = responses
    .filter((response) => response.status === "not_attending")
    .map((response) => response.userId);

  const embed = new EmbedBuilder()
    .setTitle(`Signup responses — ${event.name}`)
    .setDescription(`Event ID: **#${event.id}**`)
    .addFields(
      {
        name: `✅ Attending (${attending.length})`,

        value: formatUserMentions(attending),

        inline: false,
      },
      {
        name: `❔ Tentative (${tentative.length})`,

        value: formatUserMentions(tentative),

        inline: false,
      },
      {
        name: `❌ Not attending (${notAttending.length})`,

        value: formatUserMentions(notAttending),

        inline: false,
      },
    )
    .setTimestamp();

  await interaction.editReply({
    embeds: [embed],

    allowedMentions: {
      parse: [],
    },
  });
}
