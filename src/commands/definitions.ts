import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Checks whether the event bot is online."),

  new SlashCommandBuilder()
    .setName("dbcheck")
    .setDescription("Checks the bot's PostgreSQL connection.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configures this Discord server for event management.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("initialise")
        .setDescription(
          "Registers this server and creates its default event types.",
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Shows whether this server has been configured."),
    ),
].map((command) => command.toJSON());
