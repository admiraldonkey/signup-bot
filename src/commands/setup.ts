import {
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { asc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { discordGuilds, eventTypes, guildSettings } from "../db/schema.js";

const DEFAULT_EVENT_TYPES = [
  {
    code: "naval",
    name: "Naval",
    description: "Standard naval-based events.",
    roleRequestsEnabled: true,
  },
  {
    code: "linebattle",
    name: "Linebattle",
    description: "Standard land-based regiment events.",
    roleRequestsEnabled: true,
  },
  {
    code: "competition",
    name: "Competition",
    description: "Competitive and tournament-style events.",
    roleRequestsEnabled: true,
  },
] as const;

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (
    !interaction.inGuild() ||
    !interaction.guildId ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "You need the Manage Server permission to configure the bot.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  const subcommand = interaction.options.getSubcommand();

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  if (subcommand === "initialise") {
    await initialiseGuild(interaction);
    return;
  }

  if (subcommand === "status") {
    await showSetupStatus(interaction);
    return;
  }

  throw new Error(`Unknown setup subcommand: ${subcommand}`);
}

async function initialiseGuild(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const discordGuildId = interaction.guildId;

  if (!discordGuildId) {
    throw new Error("The setup command requires a Discord server.");
  }

  const guildName =
    interaction.guild?.name ?? `Discord server ${discordGuildId}`;

  const configuredGuild = await db.transaction(async (transaction) => {
    const now = new Date();

    const [guild] = await transaction
      .insert(discordGuilds)
      .values({
        discordGuildId,
        name: guildName,
        timezone: "Europe/London",
        enabled: true,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: discordGuilds.discordGuildId,
        set: {
          name: guildName,
          enabled: true,
          updatedAt: now,
        },
      })
      .returning({
        id: discordGuilds.id,
        name: discordGuilds.name,
      });

    if (!guild) {
      throw new Error("Failed to create or retrieve the guild record.");
    }

    await transaction
      .insert(guildSettings)
      .values({
        guildId: guild.id,
        updatedAt: now,
      })
      .onConflictDoNothing();

    for (const eventType of DEFAULT_EVENT_TYPES) {
      await transaction
        .insert(eventTypes)
        .values({
          ownerGuildId: guild.id,
          code: eventType.code,
          name: eventType.name,
          description: eventType.description,
          roleRequestsEnabled: eventType.roleRequestsEnabled,
          active: true,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [eventTypes.ownerGuildId, eventTypes.code],
          set: {
            name: eventType.name,
            description: eventType.description,
            roleRequestsEnabled: eventType.roleRequestsEnabled,
            active: true,
            updatedAt: now,
          },
        });
    }

    return guild;
  });

  await interaction.editReply(
    [
      `✅ **${configuredGuild.name}** is configured.`,
      "",
      "Default event types:",
      "• Naval",
      "• Linebattle",
      "• Competition",
      "",
      "Running this command again is safe and will not create duplicates.",
    ].join("\n"),
  );
}

async function showSetupStatus(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const discordGuildId = interaction.guildId;

  if (!discordGuildId) {
    throw new Error("The setup command requires a Discord server.");
  }

  const [guild] = await db
    .select({
      id: discordGuilds.id,
      name: discordGuilds.name,
      timezone: discordGuilds.timezone,
      enabled: discordGuilds.enabled,
    })
    .from(discordGuilds)
    .where(eq(discordGuilds.discordGuildId, discordGuildId))
    .limit(1);

  if (!guild) {
    await interaction.editReply(
      "This server has not been configured. " +
        "Run `/setup initialise` first.",
    );

    return;
  }

  const configuredEventTypes = await db
    .select({
      code: eventTypes.code,
      name: eventTypes.name,
      active: eventTypes.active,
    })
    .from(eventTypes)
    .where(eq(eventTypes.ownerGuildId, guild.id))
    .orderBy(asc(eventTypes.name));

  const eventTypeLines =
    configuredEventTypes.length > 0
      ? configuredEventTypes.map(
          (eventType) =>
            `• ${eventType.name} ` +
            `(\`${eventType.code}\`)` +
            `${eventType.active ? "" : " — disabled"}`,
        )
      : ["• None"];

  await interaction.editReply(
    [
      `**Server:** ${guild.name}`,
      `**Enabled:** ${guild.enabled ? "Yes" : "No"}`,
      `**Timezone:** ${guild.timezone}`,
      "",
      "**Event types:**",
      ...eventTypeLines,
      "",
      "Event channels and admin roles have not yet been configured.",
    ].join("\n"),
  );
}
