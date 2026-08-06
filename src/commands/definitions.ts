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
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("regions")
        .setDescription(
          "Creates or updates the EU, NA and global event regions.",
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Shows the server's current bot configuration."),
    ),

  new SlashCommandBuilder()
    .setName("event")
    .setDescription("Creates and manages regiment events.")

    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription(
          "Creates a one-off event and opens attendance sign-ups.",
        )

        /*
         * Discord requires all required options to appear before
         * optional options.
         */
        .addStringOption((option) =>
          option
            .setName("event-type")
            .setDescription("The configured category for this event.")
            .setAutocomplete(true)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("region")
            .setDescription("Whether this is an EU, NA or global event.")
            .setAutocomplete(true)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The event name shown to members.")
            .setMinLength(2)
            .setMaxLength(150)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("date")
            .setDescription("Event date in YYYY-MM-DD format.")
            .setMinLength(10)
            .setMaxLength(10)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("time")
            .setDescription("Event start time in 24-hour HH:mm format.")
            .setMinLength(5)
            .setMaxLength(5)
            .setRequired(true),
        )

        .addRoleOption((option) =>
          option
            .setName("ping-role-1")
            .setDescription("The primary Discord role to notify.")
            .setRequired(true),
        )

        .addRoleOption((option) =>
          option
            .setName("ping-role-2")
            .setDescription("An additional Discord role to notify."),
        )

        .addRoleOption((option) =>
          option
            .setName("ping-role-3")
            .setDescription("A third Discord role to notify."),
        )

        .addRoleOption((option) =>
          option
            .setName("ping-role-4")
            .setDescription("A fourth Discord role to notify."),
        )

        .addStringOption((option) =>
          option
            .setName("timezone")
            .setDescription(
              "Timezone for the entered time; defaults to the selected region.",
            )
            .setAutocomplete(true),
        )

        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("Optional information shown in the event message.")
            .setMaxLength(1000),
        )

        .addIntegerOption((option) =>
          option
            .setName("duration-minutes")
            .setDescription("Expected event duration. Defaults to 120 minutes.")
            .setMinValue(30)
            .setMaxValue(480),
        )

        .addIntegerOption((option) =>
          option
            .setName("close-minutes-before")
            .setDescription(
              "When sign-ups close. Defaults to 60 minutes before.",
            )
            .setMinValue(0)
            .setMaxValue(1440),
        )

        .addBooleanOption((option) =>
          option
            .setName("detailed-deadline")
            .setDescription(
              "Show the full sign-up deadline instead of only relative time.",
            ),
        ),
    ),
].map((command) => command.toJSON());
