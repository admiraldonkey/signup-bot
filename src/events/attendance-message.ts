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

export interface AttendanceOrganiserDisplay {
  discordUserId: string;

  status:
    | "pending"
    | "confirmed"
    | "declined"
    | "timed_out"
    | "replaced"
    | "removed";
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
  organiser: AttendanceOrganiserDisplay | null;
  signupsEnabled: boolean;
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

function formatOrganiser(organiser: AttendanceOrganiserDisplay | null): string {
  if (!organiser) {
    return "Not assigned";
  }

  const status = (() => {
    switch (organiser.status) {
      case "pending":
        return "🟡 Awaiting confirmation";

      case "confirmed":
        return "✅ Confirmed";

      case "declined":
        return "❌ Declined";

      case "timed_out":
        return "⏱️ No response";

      case "replaced":
        return "Replaced";

      case "removed":
        return "Removed";
    }
  })();

  return `<@${organiser.discordUserId}> • ${status}`;
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

  const customDescription = event.description?.trim();

  const descriptionParts: string[] = [];

  if (customDescription) {
    descriptionParts.push(customDescription);
  } else if (event.signupsEnabled) {
    descriptionParts.push("Use the buttons below to record your attendance.");
  }

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
      : [`<t:${startTimestamp}:F>`, `<t:${startTimestamp}:R>`].join("\n");

  const embed = new EmbedBuilder().setTitle(getEventTitle(event));

  descriptionParts.push(
    [
      "**Details**",
      `${event.eventTypeName} • ${event.audienceName} • ${scheduledStartText}`,
    ].join("\n"),
  );

  descriptionParts.push(
    ["**Organiser**", formatOrganiser(event.organiser)].join("\n"),
  );

  descriptionParts.push(["**Starts At**", startDisplayValue].join("\n"));

  if (event.signupsEnabled) {
    descriptionParts.push(["**Sign-ups Close**", deadlineValue].join("\n"));

    descriptionParts.push(
      [
        "**Attendance**",
        `✅ ${counts.attending} • ❔ ${counts.tentative} • ❌ ${counts.not_attending}`,
        "",
      ].join("\n"),
    );
  }

  embed.setDescription(descriptionParts.join("\n\n"));
  embed
    .setFooter({
      text: `\u200B\nEvent ID: ${event.id} • Last updated`,
    })
    .setTimestamp(new Date());

  return embed;
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
