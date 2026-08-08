import type { AutocompleteInteraction } from "discord.js";
import { and, asc, eq, ilike, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { discordGuilds, eventTypes } from "../db/schema.js";

export async function handleAttendanceAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  if (interaction.commandName !== "attendance" || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const subcommand = interaction.options.getSubcommand(false);

  if (subcommand !== "user" && subcommand !== "issues") {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);

  if (focused.name !== "event-type") {
    await interaction.respond([]);
    return;
  }

  const searchText = String(focused.value).trim();

  const searchPattern = `%${searchText}%`;

  /*
   * Do not require active=true here.
   * Historical reports should still be able to filter by
   * an event type that has since been disabled.
   */
  const availableEventTypes = await db
    .select({
      id: eventTypes.id,

      code: eventTypes.code,

      name: eventTypes.name,
    })
    .from(eventTypes)
    .innerJoin(discordGuilds, eq(discordGuilds.id, eventTypes.ownerGuildId))
    .where(
      and(
        eq(discordGuilds.discordGuildId, interaction.guildId),

        searchText.length > 0
          ? or(
              ilike(eventTypes.name, searchPattern),
              ilike(eventTypes.code, searchPattern),
            )
          : undefined,
      ),
    )
    .orderBy(asc(eventTypes.name))
    .limit(25);

  await interaction.respond(
    availableEventTypes.map((eventType) => ({
      name: eventType.name,

      value: String(eventType.id),
    })),
  );
}
