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
            .setName("event-organiser-role")
            .setDescription(
              "Role containing members who can organise events or claim cover.",
            ),
        )

        .addChannelOption((option) =>
          option
            .setName("event-admin-channel")
            .setDescription(
              "Private channel for organiser and event administration messages.",
            )
            .addChannelTypes(ChannelType.GuildText),
        )

        .addIntegerOption((option) =>
          option
            .setName("organiser-primary-minutes")
            .setDescription(
              "Minutes a primary organiser has to confirm. Defaults to 80.",
            )
            .setMinValue(1)
            .setMaxValue(10080),
        )

        .addIntegerOption((option) =>
          option
            .setName("organiser-backup-minutes")
            .setDescription(
              "Minutes an activated backup has to confirm. Defaults to 40.",
            )
            .setMinValue(1)
            .setMaxValue(10080),
        )

        .addIntegerOption((option) =>
          option
            .setName("organiser-warning-minutes")
            .setDescription(
              "Minutes before organiser timeout to warn admins. 0 disables warnings.",
            )
            .setMinValue(0)
            .setMaxValue(1440),
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
        .setName("logging")
        .setDescription("Sets the channel used for bot audit logs.")

        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel that should receive audit logs.")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            )
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("logging-disable")
        .setDescription("Disables Discord audit-log mirroring."),
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
        .setDescription("Creates a one-off regiment event.")

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

        .addUserOption((option) =>
          option
            .setName("primary-organiser")
            .setDescription(
              "Member primarily responsible for organising this event.",
            ),
        )

        .addUserOption((option) =>
          option
            .setName("backup-organiser")
            .setDescription(
              "Optional standby organiser if the primary becomes unavailable.",
            ),
        )

        .addBooleanOption((option) =>
          option
            .setName("signups")
            .setDescription(
              "Enable attendance signups for this event. Defaults to Yes.",
            ),
        )

        .addIntegerOption((option) =>
          option
            .setName("duration-minutes")
            .setDescription("Expected event duration. Defaults to 60 minutes.")
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
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("organiser-set")
        .setDescription("Assigns or replaces an organiser for an event.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event whose organiser should be changed.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("slot")
            .setDescription(
              "Whether to assign the primary or backup organiser.",
            )
            .addChoices(
              {
                name: "Primary organiser",
                value: "primary",
              },
              {
                name: "Backup organiser",
                value: "backup",
              },
            )
            .setRequired(true),
        )

        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The member to assign.")
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("organiser-clear")
        .setDescription("Removes the current primary or backup organiser.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event whose organiser should be removed.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("slot")
            .setDescription("Which organiser assignment should be removed.")
            .addChoices(
              {
                name: "Primary organiser",
                value: "primary",
              },
              {
                name: "Backup organiser",
                value: "backup",
              },
            )
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("reminder-add")
        .setDescription("Adds a scheduled custom reminder to an event.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event to add the reminder to.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("relative-to")
            .setDescription("The event time the reminder is relative to.")
            .addChoices(
              {
                name: "Signup close",
                value: "signup_close",
              },
              {
                name: "Event start",
                value: "event_start",
              },
            )
            .setRequired(true),
        )

        .addIntegerOption((option) =>
          option
            .setName("minutes-before")
            .setDescription(
              "How many minutes before the selected time to send it.",
            )
            .setMinValue(0)
            .setMaxValue(10080)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("message")
            .setDescription("The custom reminder message.")
            .setMaxLength(1800)
            .setRequired(true),
        )

        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription(
              "Destination channel. Defaults to the event attendance channel.",
            )
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        )

        .addBooleanOption((option) =>
          option
            .setName("ping-event-roles")
            .setDescription(
              "Ping the event's configured roles. Defaults to Yes.",
            ),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("reminder-list")
        .setDescription("Lists reminders configured for an event.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event whose reminders should be shown.")
            .setMinValue(1)
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("reminder-remove")
        .setDescription("Removes a reminder that has not yet been sent.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event containing the reminder.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addIntegerOption((option) =>
          option
            .setName("reminder-id")
            .setDescription("The reminder ID shown by reminder-list.")
            .setMinValue(1)
            .setRequired(true),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("reminder-edit")
        .setDescription("Edits a pending event reminder.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event containing the reminder.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addIntegerOption((option) =>
          option
            .setName("reminder-id")
            .setDescription("The reminder ID shown by reminder-list.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("relative-to")
            .setDescription(
              "Change what the reminder is scheduled relative to.",
            )
            .addChoices(
              {
                name: "Signup close",
                value: "signup_close",
              },
              {
                name: "Event start",
                value: "event_start",
              },
            ),
        )

        .addIntegerOption((option) =>
          option
            .setName("minutes-before")
            .setDescription(
              "Change how many minutes before the selected time it sends.",
            )
            .setMinValue(0)
            .setMaxValue(10080),
        )

        .addStringOption((option) =>
          option
            .setName("message")
            .setDescription("Replace the reminder message.")
            .setMaxLength(1800),
        )

        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Change the reminder destination channel.")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        )

        .addBooleanOption((option) =>
          option
            .setName("ping-event-roles")
            .setDescription(
              "Change whether the reminder pings the event roles.",
            ),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("announce")
        .setDescription("Sends an immediate custom announcement for an event.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event this announcement relates to.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("message")
            .setDescription("The announcement message.")
            .setMaxLength(1800)
            .setRequired(true),
        )

        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription(
              "Destination channel. Defaults to the event attendance channel.",
            )
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        )

        .addBooleanOption((option) =>
          option
            .setName("ping-event-roles")
            .setDescription("Ping the event's roles. Defaults to No."),
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName("edit")
        .setDescription("Edits the details or schedule of an existing event.")

        .addIntegerOption((option) =>
          option
            .setName("event-id")
            .setDescription("The event to edit.")
            .setMinValue(1)
            .setRequired(true),
        )

        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("New event name.")
            .setMaxLength(100),
        )

        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("New event description.")
            .setMaxLength(1000),
        )

        .addBooleanOption((option) =>
          option
            .setName("clear-description")
            .setDescription(
              "Remove the custom description and restore the default attendance instructions.",
            ),
        )

        .addStringOption((option) =>
          option
            .setName("date")
            .setDescription("New event date in YYYY-MM-DD format.")
            .setMinLength(10)
            .setMaxLength(10),
        )

        .addStringOption((option) =>
          option
            .setName("time")
            .setDescription("New event time in HH:mm format.")
            .setMinLength(5)
            .setMaxLength(5),
        )

        .addStringOption((option) =>
          option
            .setName("timezone")
            .setDescription("New organiser timezone.")
            .setAutocomplete(true),
        )

        .addIntegerOption((option) =>
          option
            .setName("duration-minutes")
            .setDescription("New event duration.")
            .setMinValue(30)
            .setMaxValue(480),
        )

        .addIntegerOption((option) =>
          option
            .setName("close-minutes-before")
            .setDescription("New signup-close offset before event start.")
            .setMinValue(0)
            .setMaxValue(1440),
        )

        .addBooleanOption((option) =>
          option
            .setName("detailed-deadline")
            .setDescription("Whether to show the detailed signup deadline."),
        )

        .addRoleOption((option) =>
          option
            .setName("ping-role-1")
            .setDescription(
              "Ping role 1. Supplying any ping roles replaces the current role set.",
            ),
        )

        .addRoleOption((option) =>
          option
            .setName("ping-role-2")
            .setDescription(
              "Additional ping role for the replacement role set.",
            ),
        )

        .addRoleOption((option) =>
          option
            .setName("ping-role-3")
            .setDescription(
              "Additional ping role for the replacement role set.",
            ),
        )

        .addRoleOption((option) =>
          option
            .setName("ping-role-4")
            .setDescription(
              "Additional ping role for the replacement role set.",
            ),
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

  new SlashCommandBuilder()
    .setName("audit")
    .setDescription("Views the bot's administrative audit trail.")

    .addSubcommand((subcommand) =>
      subcommand
        .setName("recent")
        .setDescription("Shows recent administrative actions.")

        .addIntegerOption((option) =>
          option
            .setName("limit")
            .setDescription("Number of entries to show. Defaults to 10.")
            .setMinValue(1)
            .setMaxValue(20),
        )

        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Only show actions performed by this user."),
        )

        .addStringOption((option) =>
          option
            .setName("outcome")
            .setDescription("Only show entries with this outcome.")
            .addChoices(
              {
                name: "Success",
                value: "success",
              },
              {
                name: "Denied",
                value: "denied",
              },
              {
                name: "Failure",
                value: "failure",
              },
            ),
        ),
    ),
].map((command) => command.toJSON());
