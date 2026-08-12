import { type ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { DateTime } from "luxon";

import {
  getGuildConfiguration,
  memberCanManageEvents,
} from "../auth/event-admin.js";
import { db } from "../db/client.js";
import {
  actualAttendanceRecords,
  attendanceResponses,
  eventAttendanceReports,
  events,
  eventTypes,
} from "../db/schema.js";

type CachedInteraction = ChatInputCommandInteraction<"cached">;

const DATE_FORMAT = "yyyy-MM-dd";

interface ReportFilters {
  eventTypeId: number | null;
  eventTypeName: string | null;

  since: Date | null;

  untilExclusive: Date | null;

  sinceLabel: string | null;

  untilLabel: string | null;
}

interface AuditedEvent {
  id: number;
  name: string;
  startsAt: Date;
  eventTypeName: string;
  /*
   * No-signup events can still contribute to actual-attendance
   * totals, but must never generate signup behaviour/issues.
   */
  signupsEnabled: boolean;
}

export async function handleAttendanceUserReport(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getReportingContext(interaction);

  if (!context) {
    return;
  }

  const filters = await resolveReportFilters(
    interaction,
    context.guildId,
    context.timezone,
  );

  if (!filters) {
    return;
  }

  const user = interaction.options.getUser("user", true);

  const auditedEvents = await loadAuditedEvents(context.guildId, filters);

  if (auditedEvents.length === 0) {
    await interaction.editReply(
      "No events with recorded actual attendance match those filters.",
    );

    return;
  }

  const eventIds = auditedEvents.map((event) => event.id);

  const [signupRows, actualRows] = await Promise.all([
    db
      .select({
        eventId: attendanceResponses.eventId,

        status: attendanceResponses.status,
      })
      .from(attendanceResponses)
      .where(
        and(
          inArray(attendanceResponses.eventId, eventIds),

          eq(attendanceResponses.discordUserId, user.id),
        ),
      ),

    db
      .select({
        eventId: actualAttendanceRecords.eventId,
      })
      .from(actualAttendanceRecords)
      .where(
        and(
          inArray(actualAttendanceRecords.eventId, eventIds),

          eq(actualAttendanceRecords.discordUserId, user.id),
        ),
      ),
  ]);

  /*
   * Only signup-enabled events may contribute signup responses to
   * behavioural reporting.
   *
   * This also protects historical reporting if bad/stale response
   * data somehow exists against a no-signup event.
   */
  const signupEnabledEventIds = new Set(
    auditedEvents
      .filter((event) => event.signupsEnabled)
      .map((event) => event.id),
  );

  const signupByEvent = new Map(
    signupRows
      .filter((row) => signupEnabledEventIds.has(row.eventId))
      .map((row) => [row.eventId, row.status]),
  );

  const attendedEventIds = new Set(actualRows.map((row) => row.eventId));

  /*
   * An event is relevant when:
   *
   * - the member actually attended it; or
   * - it used signups and the member responded.
   *
   * A no-signup event therefore becomes relevant only through
   * actual attendance.
   */
  const relevantEvents = auditedEvents.filter(
    (event) =>
      attendedEventIds.has(event.id) ||
      (event.signupsEnabled && signupByEvent.has(event.id)),
  );

  let attendingSignups = 0;

  let attendingPresent = 0;

  let tentativeSignups = 0;

  let tentativePresent = 0;

  let noResponseWalkIns = 0;

  let notAttendingWalkIns = 0;

  const noShowEvents: AuditedEvent[] = [];

  const walkInEvents: AuditedEvent[] = [];

  for (const event of relevantEvents) {
    /*
     * No-signup events may contribute to actual attendance, but
     * cannot create no-shows, walk-ins or other signup behaviour.
     */
    if (!event.signupsEnabled) {
      continue;
    }

    const signup = signupByEvent.get(event.id);

    const attended = attendedEventIds.has(event.id);

    if (signup === "attending") {
      attendingSignups += 1;

      if (attended) {
        attendingPresent += 1;
      } else {
        noShowEvents.push(event);
      }

      continue;
    }

    if (signup === "tentative") {
      tentativeSignups += 1;

      if (attended) {
        tentativePresent += 1;
      }

      continue;
    }

    if (signup === "not_attending") {
      if (attended) {
        notAttendingWalkIns += 1;

        walkInEvents.push(event);
      }

      continue;
    }

    if (attended) {
      noResponseWalkIns += 1;

      walkInEvents.push(event);
    }
  }

  const noShows = attendingSignups - attendingPresent;

  const tentativeAbsent = tentativeSignups - tentativePresent;

  const walkIns = noResponseWalkIns + notAttendingWalkIns;

  /*
   * Actual attendance includes no-signup events.
   */
  const actualAttendances = relevantEvents.filter((event) =>
    attendedEventIds.has(event.id),
  ).length;

  const signupRelevantEvents = relevantEvents.filter(
    (event) => event.signupsEnabled,
  ).length;

  const embed = new EmbedBuilder()
    .setTitle(`Attendance history — ${user.displayName}`)
    .setDescription(
      [
        `<@${user.id}>`,
        "",
        `**Relevant audited events:** ${relevantEvents.length}`,
        `**Actual attendances:** ${actualAttendances}`,
        `**Events with signup tracking:** ${signupRelevantEvents}`,
        `**Event type:** ${filters.eventTypeName ?? "All"}`,
        `**Period:** ${formatPeriod(filters)}`,
      ].join("\n"),
    )
    .addFields(
      {
        name: "✅ Attending signups",

        value: [
          `Signed attending: **${attendingSignups}**`,
          `Attended: **${attendingPresent}**`,
          `No-shows: **${noShows}**`,
        ].join("\n"),

        inline: true,
      },

      {
        name: "❔ Tentative signups",

        value: [
          `Tentative: **${tentativeSignups}**`,
          `Attended: **${tentativePresent}**`,
          `Absent: **${tentativeAbsent}**`,
        ].join("\n"),

        inline: true,
      },

      {
        name: "🚶 Without positive signup",

        value: [
          `Total: **${walkIns}**`,
          `No response: **${noResponseWalkIns}**`,
          `Said Not attending: **${notAttendingWalkIns}**`,
        ].join("\n"),

        inline: true,
      },

      {
        name: `🚫 No-show events (${noShowEvents.length})`,

        value: formatEventList(noShowEvents),

        inline: false,
      },

      {
        name: `⚠️ Attended without positive signup (${walkInEvents.length})`,

        value: formatEventList(walkInEvents),

        inline: false,
      },
    )
    .setFooter({
      text: "No-signup events count towards actual attendance but not signup issues. Tentative absences are shown for context only.",
    })
    .setTimestamp();

  await interaction.editReply({
    embeds: [embed],

    allowedMentions: {
      parse: [],
    },
  });
}

export async function handleAttendanceIssuesReport(
  interaction: CachedInteraction,
): Promise<void> {
  const context = await getReportingContext(interaction);

  if (!context) {
    return;
  }

  const filters = await resolveReportFilters(
    interaction,
    context.guildId,
    context.timezone,
  );

  if (!filters) {
    return;
  }

  const limit = interaction.options.getInteger("limit") ?? 15;

  const allAuditedEvents = await loadAuditedEvents(context.guildId, filters);

  /*
   * Attendance issues only make sense when members were actually
   * given the opportunity to submit a signup response.
   */
  const auditedEvents = allAuditedEvents.filter(
    (event) => event.signupsEnabled,
  );

  if (auditedEvents.length === 0) {
    await interaction.editReply(
      "No signup-enabled events with recorded actual attendance match those filters.",
    );

    return;
  }

  const eventIds = auditedEvents.map((event) => event.id);

  const [signupRows, actualRows] = await Promise.all([
    db
      .select({
        eventId: attendanceResponses.eventId,

        userId: attendanceResponses.discordUserId,

        status: attendanceResponses.status,
      })
      .from(attendanceResponses)
      .where(inArray(attendanceResponses.eventId, eventIds)),

    db
      .select({
        eventId: actualAttendanceRecords.eventId,

        userId: actualAttendanceRecords.discordUserId,
      })
      .from(actualAttendanceRecords)
      .where(inArray(actualAttendanceRecords.eventId, eventIds)),
  ]);

  const signupByEventUser = new Map<
    string,
    (typeof signupRows)[number]["status"]
  >();

  for (const row of signupRows) {
    signupByEventUser.set(
      makeEventUserKey(row.eventId, row.userId),

      row.status,
    );
  }

  const actualKeys = new Set(
    actualRows.map((row) => makeEventUserKey(row.eventId, row.userId)),
  );

  interface UserIssues {
    userId: string;

    noShows: number;

    noResponseWalkIns: number;

    notAttendingWalkIns: number;
  }

  const issuesByUser = new Map<string, UserIssues>();

  function getIssues(userId: string): UserIssues {
    const existing = issuesByUser.get(userId);

    if (existing) {
      return existing;
    }

    const created: UserIssues = {
      userId,

      noShows: 0,

      noResponseWalkIns: 0,

      notAttendingWalkIns: 0,
    };

    issuesByUser.set(userId, created);

    return created;
  }

  /*
   * Attending signup but absent.
   */
  for (const signup of signupRows) {
    if (signup.status !== "attending") {
      continue;
    }

    const key = makeEventUserKey(signup.eventId, signup.userId);

    if (!actualKeys.has(key)) {
      getIssues(signup.userId).noShows += 1;
    }
  }

  /*
   * Present without Attending or Tentative.
   */
  for (const actual of actualRows) {
    const key = makeEventUserKey(actual.eventId, actual.userId);

    const signup = signupByEventUser.get(key);

    if (!signup) {
      getIssues(actual.userId).noResponseWalkIns += 1;

      continue;
    }

    if (signup === "not_attending") {
      getIssues(actual.userId).notAttendingWalkIns += 1;
    }
  }

  const ranked = [...issuesByUser.values()]
    .map((entry) => ({
      ...entry,

      total:
        entry.noShows + entry.noResponseWalkIns + entry.notAttendingWalkIns,
    }))
    .filter((entry) => entry.total > 0)
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.noShows - a.noShows ||
        b.noResponseWalkIns - a.noResponseWalkIns,
    )
    .slice(0, limit);

  if (ranked.length === 0) {
    await interaction.editReply(
      [
        "✅ No attendance issues were found for the selected period.",
        "",
        `Signup-enabled audited events checked: ${auditedEvents.length}`,
      ].join("\n"),
    );

    return;
  }

  const lines = ranked.map((entry, index) =>
    [
      `**${index + 1}. <@${entry.userId}> — ${entry.total} issue${entry.total === 1 ? "" : "s"}**`,

      `No-shows: ${entry.noShows} • No signup: ${entry.noResponseWalkIns} • Said Not attending: ${entry.notAttendingWalkIns}`,
    ].join("\n"),
  );

  const embed = new EmbedBuilder()
    .setTitle("Attendance issues")
    .setDescription(
      [
        `**Signup-enabled audited events:** ${auditedEvents.length}`,
        `**Event type:** ${filters.eventTypeName ?? "All"}`,
        `**Period:** ${formatPeriod(filters)}`,
        "",
        ...lines,
      ].join("\n"),
    )
    .setFooter({
      text: "No-signup events are excluded. Tentative absences are not treated as issues.",
    })
    .setTimestamp();

  await interaction.editReply({
    embeds: [embed],

    allowedMentions: {
      parse: [],
    },
  });
}

async function getReportingContext(interaction: CachedInteraction) {
  const configuration = await getGuildConfiguration(interaction.guildId);

  if (!configuration) {
    await interaction.editReply("This server has not been initialised.");

    return null;
  }

  if (!configuration.enabled) {
    await interaction.editReply(
      "Event management is currently disabled for this server.",
    );

    return null;
  }

  if (
    !memberCanManageEvents(interaction.member, configuration.eventAdminRoleId)
  ) {
    await interaction.editReply(
      "You need the configured Event Admin role " +
        "or the Manage Server permission to view attendance reports.",
    );

    return null;
  }

  return {
    guildId: configuration.guildId,

    timezone: configuration.timezone,
  };
}

async function resolveReportFilters(
  interaction: CachedInteraction,
  guildDatabaseId: number,
  timezone: string,
): Promise<ReportFilters | null> {
  const eventTypeIdText = interaction.options.getString("event-type");

  let eventTypeId: number | null = null;

  let eventTypeName: string | null = null;

  if (eventTypeIdText) {
    const parsedEventTypeId = Number(eventTypeIdText);

    if (!Number.isSafeInteger(parsedEventTypeId) || parsedEventTypeId <= 0) {
      await interaction.editReply(
        "The selected event type is invalid. Use the autocomplete list.",
      );

      return null;
    }

    const [eventType] = await db
      .select({
        id: eventTypes.id,

        name: eventTypes.name,
      })
      .from(eventTypes)
      .where(
        and(
          eq(eventTypes.id, parsedEventTypeId),

          eq(eventTypes.ownerGuildId, guildDatabaseId),
        ),
      )
      .limit(1);

    if (!eventType) {
      await interaction.editReply(
        "That event type does not belong to this server.",
      );

      return null;
    }

    eventTypeId = eventType.id;

    eventTypeName = eventType.name;
  }

  const sinceText = interaction.options.getString("since")?.trim() || null;

  const untilText = interaction.options.getString("until")?.trim() || null;

  const sinceDateTime = sinceText ? parseReportDate(sinceText, timezone) : null;

  if (sinceText && !sinceDateTime) {
    await interaction.editReply(
      "`since` must be a real date in `YYYY-MM-DD` format.",
    );

    return null;
  }

  const untilDateTime = untilText ? parseReportDate(untilText, timezone) : null;

  if (untilText && !untilDateTime) {
    await interaction.editReply(
      "`until` must be a real date in `YYYY-MM-DD` format.",
    );

    return null;
  }

  if (sinceDateTime && untilDateTime && sinceDateTime > untilDateTime) {
    await interaction.editReply("`since` cannot be later than `until`.");

    return null;
  }

  return {
    eventTypeId,
    eventTypeName,

    since: sinceDateTime?.startOf("day").toJSDate() ?? null,

    /*
     * Make `until` inclusive by filtering events before the
     * beginning of the following local calendar day.
     */
    untilExclusive:
      untilDateTime
        ?.plus({
          days: 1,
        })
        .startOf("day")
        .toJSDate() ?? null,

    sinceLabel: sinceDateTime?.toFormat("dd LLL yyyy") ?? null,

    untilLabel: untilDateTime?.toFormat("dd LLL yyyy") ?? null,
  };
}

async function loadAuditedEvents(
  guildDatabaseId: number,
  filters: ReportFilters,
): Promise<AuditedEvent[]> {
  return db
    .select({
      id: events.id,

      name: events.name,

      startsAt: events.startsAt,

      eventTypeName: eventTypes.name,

      signupsEnabled: events.signupsEnabled,
    })
    .from(events)
    .innerJoin(
      eventAttendanceReports,
      eq(eventAttendanceReports.eventId, events.id),
    )
    .innerJoin(eventTypes, eq(eventTypes.id, events.eventTypeId))
    .where(
      and(
        eq(events.ownerGuildId, guildDatabaseId),

        /*
         * Only completed events contribute to historical attendance
         * reporting. Actual attendance may still be recorded while an
         * event is in progress.
         */
        eq(events.status, "completed"),

        filters.eventTypeId !== null
          ? eq(events.eventTypeId, filters.eventTypeId)
          : undefined,

        filters.since ? gte(events.startsAt, filters.since) : undefined,

        filters.untilExclusive
          ? lt(events.startsAt, filters.untilExclusive)
          : undefined,
      ),
    )
    .orderBy(asc(events.startsAt));
}

function parseReportDate(text: string, timezone: string): DateTime | null {
  const parsed = DateTime.fromFormat(text, DATE_FORMAT, {
    zone: timezone,

    locale: "en-GB",

    setZone: true,
  });

  if (!parsed.isValid || parsed.toFormat(DATE_FORMAT) !== text) {
    return null;
  }

  return parsed;
}

function formatPeriod(filters: ReportFilters): string {
  if (filters.sinceLabel && filters.untilLabel) {
    return `${filters.sinceLabel} – ` + `${filters.untilLabel}`;
  }

  if (filters.sinceLabel) {
    return `${filters.sinceLabel} onwards`;
  }

  if (filters.untilLabel) {
    return `Up to ${filters.untilLabel}`;
  }

  return "All recorded history";
}

function formatEventList(matchingEvents: AuditedEvent[]): string {
  if (matchingEvents.length === 0) {
    return "None";
  }

  const maximumShown = 8;

  const newestFirst = [...matchingEvents]
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
    .slice(0, maximumShown);

  const lines = newestFirst.map((event) => {
    const timestamp = Math.floor(event.startsAt.getTime() / 1000);

    return `• <t:${timestamp}:d> ` + `${event.name} (#${event.id})`;
  });

  const remaining = matchingEvents.length - newestFirst.length;

  if (remaining > 0) {
    lines.push(`• + ${remaining} more`);
  }

  return lines.join("\n");
}

function makeEventUserKey(eventId: number, userId: string): string {
  return `${eventId}:${userId}`;
}
