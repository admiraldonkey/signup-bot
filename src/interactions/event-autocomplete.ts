import { type AutocompleteInteraction } from "discord.js";
import { and, asc, eq, ilike, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { discordGuilds, eventAudiences, eventTypes } from "../db/schema.js";
import { findTimezoneOptions } from "../time/timezones.js";

export async function handleEventAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  if (interaction.commandName !== "event" || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const subcommand = interaction.options.getSubcommand(false);

  if (subcommand !== "create") {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);

  const searchText = String(focused.value).trim();

  /*
   * Timezones come from our curated list rather than PostgreSQL.
   */
  if (focused.name === "timezone") {
    const matches = findTimezoneOptions(searchText).slice(0, 25);

    await interaction.respond(
      matches.map((timezone) => ({
        name: timezone.label,
        value: timezone.value,
      })),
    );

    return;
  }

  const searchPattern = `%${searchText}%`;

  /*
   * Regional audience autocomplete, such as EU or NA.
   */
  if (focused.name === "region") {
    const audiences = await db
      .select({
        id: eventAudiences.id,
        code: eventAudiences.code,
        name: eventAudiences.name,
      })
      .from(eventAudiences)
      .innerJoin(
        discordGuilds,
        eq(discordGuilds.id, eventAudiences.ownerGuildId),
      )
      .where(
        and(
          eq(discordGuilds.discordGuildId, interaction.guildId),
          eq(discordGuilds.enabled, true),
          eq(eventAudiences.active, true),

          searchText.length > 0
            ? or(
                ilike(eventAudiences.name, searchPattern),
                ilike(eventAudiences.code, searchPattern),
              )
            : undefined,
        ),
      )
      .orderBy(asc(eventAudiences.name))
      .limit(25);

    await interaction.respond(
      audiences.map((audience) => ({
        name: audience.name,
        value: String(audience.id),
      })),
    );

    return;
  }

  /*
   * Configured event types, such as Naval, Linebattle or Competition.
   */
  if (focused.name === "event-type") {
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
          eq(discordGuilds.enabled, true),
          eq(eventTypes.active, true),

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

    return;
  }

  /*
   * Unknown autocomplete option. Responding with an empty list prevents
   * Discord from waiting until the interaction expires.
   */
  await interaction.respond([]);
}
