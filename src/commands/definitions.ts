import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

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
        .setName("configure")
        .setDescription("Sets the server's default event roles and channels.")

        .addRoleOption((option) =>
          option
            .setName("event-admin-role")
            .setDescription("The role allowed to create and manage events.")
            .setRequired(true),
        )

        .addChannelOption((option) =>
          option
            .setName("attendance-channel")
            .setDescription("The default channel for attendance sign-ups.")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            )
            .setRequired(true),
        )

        .addChannelOption((option) =>
          option
            .setName("role-request-channel")
            .setDescription("The default channel for event role requests.")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            )
            .setRequired(true),
        )

        .addRoleOption((option) =>
          option
            .setName("ping-role")
            .setDescription("The default role pinged when attendance opens.")
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Shows the server's current bot configuration."),
    ),
].map((command) => command.toJSON());
