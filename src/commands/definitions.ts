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
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("Lists the next scheduled events for this server."),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("responses")
        .setDescription("Shows members grouped by their signup response.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event whose responses should be shown.")
            .setMinValue(1)
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("close")
        .setDescription("Closes attendance for an event.")
        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The ID of the event to close.")
            .setMinValue(1)
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("reopen")
        .setDescription("Reopens attendance for an event.")
        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The ID of the event to reopen.")
            .setMinValue(1)
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("close-minutes-before")
            .setDescription(
              "New closing deadline. Defaults to the event start.",
            )
            .setMinValue(0)
            .setMaxValue(1440),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("cancel")
        .setDescription("Cancels an event and disables its attendance buttons.")
        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The ID of the event to cancel.")
            .setMinValue(1)
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("refresh")
        .setDescription(
          "Rebuilds an event's attendance message from the database.",
        )
        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The ID of the event to refresh.")
            .setMinValue(1)
            .setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("attendance")
    .setDescription("Records and audits actual event attendance.")

    .addSubcommand((subcommand) =>
      subcommand
        .setName("record")
        .setDescription("Replaces an event's recorded actual attendance.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event whose attendance is being recorded.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("attendees")
            .setDescription(
              "Discord mentions/IDs, or 'none' if nobody attended.",
            )
            .setMaxLength(6000)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("source-reference")
            .setDescription(
              "Optional note describing where the attendance came from.",
            )
            .setMaxLength(500),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Adds one person to an event's actual attendance.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event to update.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The attendee to add.")
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Removes one person from an event's actual attendance.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event to update.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The attendee to remove.")
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("compare")
        .setDescription("Compares actual attendance with signup responses.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event to compare.")
            .setMinValue(1)
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("user")
        .setDescription("Shows attendance reliability for a specific member.")

        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription(
              "The member whose attendance history should be shown.",
            )
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("event-type")
            .setDescription("Optionally restrict the report to one event type.")
            .setAutocomplete(true),
        )

        .addStringOption((option) =>
          option
            .setName("since")
            .setDescription(
              "Only include events on or after this date (YYYY-MM-DD).",
            )
            .setMinLength(10)
            .setMaxLength(10),
        )

        .addStringOption((option) =>
          option
            .setName("until")
            .setDescription(
              "Only include events on or before this date (YYYY-MM-DD).",
            )
            .setMinLength(10)
            .setMaxLength(10),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("issues")
        .setDescription("Lists members with attendance/sign-up mismatches.")

        .addStringOption((option) =>
          option
            .setName("event-type")
            .setDescription("Optionally restrict the report to one event type.")
            .setAutocomplete(true),
        )

        .addStringOption((option) =>
          option
            .setName("since")
            .setDescription(
              "Only include events on or after this date (YYYY-MM-DD).",
            )
            .setMinLength(10)
            .setMaxLength(10),
        )

        .addStringOption((option) =>
          option
            .setName("until")
            .setDescription(
              "Only include events on or before this date (YYYY-MM-DD).",
            )
            .setMinLength(10)
            .setMaxLength(10),
        )

        .addIntegerOption((option) =>
          option
            .setName("limit")
            .setDescription(
              "Maximum number of members to show. Defaults to 15.",
            )
            .setMinValue(1)
            .setMaxValue(25),
        ),
    ),
].map((command) => command.toJSON());
