import { DateTime } from "luxon";
import { RRule } from "rrule";

const RECURRENCE_DATE_FORMAT = "yyyy-MM-dd";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const MAX_RECURRENCE_ENUMERATION_DAYS = 366;

const SUPPORTED_RULE_COMPONENTS = new Set([
  "FREQ",
  "INTERVAL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "WKST",
]);

const SUPPORTED_FREQUENCIES = new Set([
  RRule.DAILY,
  RRule.WEEKLY,
  RRule.MONTHLY,
  RRule.YEARLY,
]);

export type RecurrenceRuleInvalidReason =
  | "invalid_rule"
  | "unsupported_rule_component"
  | "unsupported_frequency";

export type NormaliseRecurrenceRuleResult =
  | {
      ok: true;

      recurrenceRule: string;
    }
  | {
      ok: false;

      reason: RecurrenceRuleInvalidReason;
    };

export type EnumerateRecurrenceDatesResult =
  | {
      ok: true;

      occurrenceDates: string[];
    }
  | {
      ok: false;

      reason:
        | RecurrenceRuleInvalidReason
        | "invalid_start_date"
        | "invalid_range"
        | "range_too_large";
    };

/**
 * Validates and canonicalises the recurrence-rule subset supported by P1.
 *
 * Recurrence deliberately describes calendar dates only.
 *
 * Clock time and timezone remain template configuration and must therefore
 * not be embedded in an RRULE.
 */
export function normaliseRecurrenceRule(
  value: string,
): NormaliseRecurrenceRuleResult {
  const trimmed = value.trim();

  if (
    trimmed.length === 0 ||
    trimmed.includes("\n") ||
    trimmed.includes("\r")
  ) {
    return {
      ok: false,

      reason: "invalid_rule",
    };
  }

  const withoutPrefix = trimmed.toUpperCase().startsWith("RRULE:")
    ? trimmed.slice(6)
    : trimmed;

  const ruleText = withoutPrefix.trim().toUpperCase();

  if (ruleText.length === 0) {
    return {
      ok: false,

      reason: "invalid_rule",
    };
  }

  const seenComponents = new Set<string>();

  let hasFrequency = false;

  for (const component of ruleText.split(";")) {
    const separatorIndex = component.indexOf("=");

    if (separatorIndex <= 0 || separatorIndex === component.length - 1) {
      return {
        ok: false,

        reason: "invalid_rule",
      };
    }

    const key = component.slice(0, separatorIndex);

    if (!SUPPORTED_RULE_COMPONENTS.has(key)) {
      return {
        ok: false,

        reason: "unsupported_rule_component",
      };
    }

    if (seenComponents.has(key)) {
      return {
        ok: false,

        reason: "invalid_rule",
      };
    }

    seenComponents.add(key);

    if (key === "FREQ") {
      hasFrequency = true;
    }
  }

  if (!hasFrequency) {
    return {
      ok: false,

      reason: "invalid_rule",
    };
  }

  try {
    const options = RRule.parseString(ruleText);

    if (options.freq === undefined) {
      return {
        ok: false,

        reason: "invalid_rule",
      };
    }

    if (!SUPPORTED_FREQUENCIES.has(options.freq)) {
      return {
        ok: false,

        reason: "unsupported_frequency",
      };
    }

    const parsedRule = new RRule(options);

    const serialised = parsedRule.toString();

    const ruleLine = serialised
      .split("\n")
      .find((line) => line.startsWith("RRULE:"));

    if (!ruleLine) {
      return {
        ok: false,

        reason: "invalid_rule",
      };
    }

    return {
      ok: true,

      recurrenceRule: ruleLine.slice("RRULE:".length),
    };
  } catch {
    return {
      ok: false,

      reason: "invalid_rule",
    };
  }
}

/**
 * Validates a recurrence-local calendar date.
 *
 * The returned value remains a YYYY-MM-DD string deliberately. It is not an
 * instant and must not be converted through the host machine's local timezone.
 */
export function normaliseRecurrenceDate(value: string): string | null {
  const trimmed = value.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  const parsed = DateTime.fromFormat(trimmed, RECURRENCE_DATE_FORMAT, {
    zone: "UTC",

    locale: "en-GB",
  });

  if (!parsed.isValid || parsed.toFormat(RECURRENCE_DATE_FORMAT) !== trimmed) {
    return null;
  }

  return trimmed;
}

/**
 * Enumerates recurrence-local calendar dates inside one bounded inclusive
 * window.
 *
 * rrule receives synthetic UTC dates here only so its calendar arithmetic can
 * operate on year/month/day components without host-timezone interference.
 *
 * These Date objects are not event instants.
 */
export function enumerateRecurrenceOccurrenceDates(input: {
  recurrenceRule: string;

  startDate: string;

  fromDate: string;

  throughDate: string;
}): EnumerateRecurrenceDatesResult {
  const normalisedRule = normaliseRecurrenceRule(input.recurrenceRule);

  if (!normalisedRule.ok) {
    return normalisedRule;
  }

  const startDate = normaliseRecurrenceDate(input.startDate);

  if (!startDate) {
    return {
      ok: false,

      reason: "invalid_start_date",
    };
  }

  const fromDate = normaliseRecurrenceDate(input.fromDate);

  const throughDate = normaliseRecurrenceDate(input.throughDate);

  if (!fromDate || !throughDate) {
    return {
      ok: false,

      reason: "invalid_range",
    };
  }

  const from = recurrenceDateToUtcDate(fromDate);

  const through = recurrenceDateToUtcDate(throughDate);

  if (through.getTime() < from.getTime()) {
    return {
      ok: false,

      reason: "invalid_range",
    };
  }

  const rangeDays = Math.round(
    (through.getTime() - from.getTime()) / MILLISECONDS_PER_DAY,
  );

  if (rangeDays > MAX_RECURRENCE_ENUMERATION_DAYS) {
    return {
      ok: false,

      reason: "range_too_large",
    };
  }

  const options = RRule.parseString(normalisedRule.recurrenceRule);

  options.dtstart = recurrenceDateToUtcDate(startDate);

  const rule = new RRule(options);

  return {
    ok: true,

    occurrenceDates: rule
      .between(from, through, true)
      .map(utcDateToRecurrenceDate),
  };
}

function recurrenceDateToUtcDate(value: string): Date {
  const [yearText, monthText, dayText] = value.split("-");

  const year = Number(yearText);

  const month = Number(monthText);

  const day = Number(dayText);

  return new Date(Date.UTC(year, month - 1, day));
}

function utcDateToRecurrenceDate(value: Date): string {
  return [
    value.getUTCFullYear().toString().padStart(4, "0"),

    (value.getUTCMonth() + 1).toString().padStart(2, "0"),

    value.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}
