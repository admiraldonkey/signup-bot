import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { DateTime } from "luxon";

export const ATTENDANCE_STATUSES = [
  "attending",
  "tentative",
  "not_attending",
] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface AttendanceCounts {
  attending: number;
  tentative: number;
  not_attending: number;
}

export interface AttendanceEventDisplay {
  id: number;
  name: string;
  description: string | null;
  eventTypeName: string;
  audienceName: string;
  timezone: string;
  showDetailedDeadline: boolean;
  startsAt: Date;
  attendanceClosesAt: Date | null;
  status: "scheduled" | "open" | "closed" | "cancelled" | "completed";
}

export const EMPTY_ATTENDANCE_COUNTS: AttendanceCounts = {
  attending: 0,
  tentative: 0,
  not_attending: 0,
};

function formatInEventTimezone(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, {
    zone: timezone,
  })
    .setLocale("en-GB")
    .toFormat("dd LLL yyyy, HH:mm ZZZZ");
}

export function buildAttendanceCustomId(
  eventId: number,
  status: AttendanceStatus,
): string {
  return `attendance:${eventId}:${status}`;
}

export function parseAttendanceCustomId(customId: string): {
  eventId: number;
  status: AttendanceStatus;
} | null {
  const match = /^attendance:(\d+):(attending|tentative|not_attending)$/.exec(
    customId,
  );

  if (!match) {
    return null;
  }

  const eventId = Number(match[1]);

  const status = match[2] as AttendanceStatus;

  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    return null;
  }

  return {
    eventId,
    status,
  };
}

export function buildAttendanceEmbed(
  event: AttendanceEventDisplay,
  counts: AttendanceCounts,
): EmbedBuilder {
  const startTimestamp = Math.floor(event.startsAt.getTime() / 1000);

  const closingTimestamp =
    event.attendanceClosesAt === null
      ? null
      : Math.floor(event.attendanceClosesAt.getTime() / 1000);

  const scheduledStartText = formatInEventTimezone(
    event.startsAt,
    event.timezone,
  );

  const scheduledClosingText =
    event.attendanceClosesAt === null
      ? null
      : formatInEventTimezone(event.attendanceClosesAt, event.timezone);

  const description =
    event.description?.trim() ||
    "Use the buttons below to record your attendance.";

  const deadlineValue =
    event.status === "cancelled"
      ? "Event cancelled"
      : event.status === "closed"
        ? "Closed"
        : event.status === "completed"
          ? "Closed"
          : closingTimestamp === null || scheduledClosingText === null
            ? "No automatic deadline"
            : event.showDetailedDeadline
              ? [`<t:${closingTimestamp}:F>`, `<t:${closingTimestamp}:R>`].join(
                  "\n",
                )
              : `<t:${closingTimestamp}:R>`;

  function getEventTitle(event: AttendanceEventDisplay): string {
    switch (event.status) {
      case "closed":
        return `🔒 ${event.name}`;

      case "cancelled":
        return `🚫 ${event.name}`;

      case "completed":
        return `✅ ${event.name}`;

      default:
        return event.name;
    }
  }

  const startDisplayValue =
    event.status === "cancelled"
      ? ["🚫 **Event cancelled**"].join("\n")
      : [
          `<t:${startTimestamp}:F> (your local time)`,
          `<t:${startTimestamp}:R>`,
        ].join("\n");

  return new EmbedBuilder()
    .setTitle(getEventTitle(event))
    .setDescription(description)
    .addFields(
      {
        name: "Event Type",
        value: event.eventTypeName,
        inline: true,
      },
      {
        name: "Region",
        value: event.audienceName,
        inline: true,
      },
      {
        name: "Host Timezone",
        value: `\`${event.timezone}\``,
        inline: true,
      },
      {
        name: "Scheduled Time",
        value: [scheduledStartText, "\n"].join("\n"),
        inline: false,
      },
      {
        name: "Starts At",
        value: startDisplayValue,
        inline: false,
      },
      {
        name: "Sign-ups Close",
        value: [deadlineValue, "\n"].join("\n"),
        inline: !event.showDetailedDeadline,
      },
      {
        name: "Attendance",
        value: [
          `✅ **Attending:** ${counts.attending}`,
          `❔ **Tentative:** ${counts.tentative}`,
          `❌ **Not attending:** ${counts.not_attending}`,
        ].join("\n"),
      },
      {
        name: "Status",
        value: event.status
          .replace("_", " ")
          .replace(/\b\w/g, (character) => character.toUpperCase()),
        inline: true,
      },
    )
    .setFooter({
      text: `Event ID: ${event.id} • Last updated`,
    })
    .setTimestamp(new Date());
}

export function buildAttendanceButtons(
  eventId: number,
  counts: AttendanceCounts,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildAttendanceCustomId(eventId, "attending"))
      .setLabel(`Attending (${counts.attending})`)
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId(buildAttendanceCustomId(eventId, "tentative"))
      .setLabel(`Tentative (${counts.tentative})`)
      .setEmoji("❔")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId(buildAttendanceCustomId(eventId, "not_attending"))
      .setLabel(`Not attending (${counts.not_attending})`)
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}
