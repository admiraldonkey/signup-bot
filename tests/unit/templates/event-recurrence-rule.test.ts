import { describe, expect, it } from "vitest";

import {
  enumerateRecurrenceOccurrenceDates,
  normaliseRecurrenceDate,
  normaliseRecurrenceRule,
} from "../../../src/templates/event-recurrence-rule.js";

describe("event recurrence rules", () => {
  it("normalises a supported weekly RRULE", () => {
    expect(normaliseRecurrenceRule("rrule:freq=weekly;byday=mo")).toEqual({
      ok: true,

      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
    });
  });

  it("rejects time and timezone components owned by the template", () => {
    expect(normaliseRecurrenceRule("FREQ=WEEKLY;BYDAY=MO;BYHOUR=20")).toEqual({
      ok: false,

      reason: "unsupported_rule_component",
    });

    expect(normaliseRecurrenceRule("FREQ=WEEKLY;COUNT=10")).toEqual({
      ok: false,

      reason: "unsupported_rule_component",
    });
  });

  it("rejects unsupported sub-daily frequencies", () => {
    expect(normaliseRecurrenceRule("FREQ=HOURLY")).toEqual({
      ok: false,

      reason: "unsupported_frequency",
    });
  });

  it("validates exact local calendar dates", () => {
    expect(normaliseRecurrenceDate("2026-10-05")).toBe("2026-10-05");

    expect(normaliseRecurrenceDate("2026-02-30")).toBeNull();

    expect(normaliseRecurrenceDate("2026-1-5")).toBeNull();
  });

  it("enumerates weekly local-date slots inside an inclusive bounded window", () => {
    expect(
      enumerateRecurrenceOccurrenceDates({
        recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",

        startDate: "2026-10-05",

        fromDate: "2026-10-01",

        throughDate: "2026-11-01",
      }),
    ).toEqual({
      ok: true,

      occurrenceDates: ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"],
    });
  });

  it("preserves local calendar slots across the autumn DST boundary", () => {
    expect(
      enumerateRecurrenceOccurrenceDates({
        recurrenceRule: "FREQ=WEEKLY;BYDAY=SU",

        startDate: "2026-10-11",

        fromDate: "2026-10-11",

        throughDate: "2026-11-01",
      }),
    ).toEqual({
      ok: true,

      occurrenceDates: ["2026-10-11", "2026-10-18", "2026-10-25", "2026-11-01"],
    });
  });

  it("supports interval-based weekly recurrence", () => {
    expect(
      enumerateRecurrenceOccurrenceDates({
        recurrenceRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",

        startDate: "2026-10-05",

        fromDate: "2026-10-01",

        throughDate: "2026-11-30",
      }),
    ).toEqual({
      ok: true,

      occurrenceDates: [
        "2026-10-05",
        "2026-10-19",
        "2026-11-02",
        "2026-11-16",
        "2026-11-30",
      ],
    });
  });

  it("anchors a simple daily recurrence at the configured start date", () => {
    expect(
      enumerateRecurrenceOccurrenceDates({
        recurrenceRule: "FREQ=DAILY",

        startDate: "2026-10-05",

        fromDate: "2026-10-03",

        throughDate: "2026-10-08",
      }),
    ).toEqual({
      ok: true,

      occurrenceDates: ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"],
    });
  });

  it("anchors a simple monthly recurrence to the start-date day of month", () => {
    expect(
      enumerateRecurrenceOccurrenceDates({
        recurrenceRule: "FREQ=MONTHLY",

        startDate: "2026-01-31",

        fromDate: "2026-01-31",

        throughDate: "2026-05-31",
      }),
    ).toEqual({
      ok: true,

      occurrenceDates: ["2026-01-31", "2026-03-31", "2026-05-31"],
    });
  });

  it("anchors a simple yearly recurrence at the configured start date", () => {
    expect(
      enumerateRecurrenceOccurrenceDates({
        recurrenceRule: "FREQ=YEARLY",

        startDate: "2026-10-05",

        fromDate: "2026-10-05",

        throughDate: "2027-10-05",
      }),
    ).toEqual({
      ok: true,

      occurrenceDates: ["2026-10-05", "2027-10-05"],
    });
  });

  it("rejects reversed or excessively large enumeration windows", () => {
    expect(
      enumerateRecurrenceOccurrenceDates({
        recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",

        startDate: "2026-10-05",

        fromDate: "2026-11-01",

        throughDate: "2026-10-01",
      }),
    ).toEqual({
      ok: false,

      reason: "invalid_range",
    });

    expect(
      enumerateRecurrenceOccurrenceDates({
        recurrenceRule: "FREQ=DAILY",

        startDate: "2026-01-01",

        fromDate: "2026-01-01",

        throughDate: "2028-01-01",
      }),
    ).toEqual({
      ok: false,

      reason: "range_too_large",
    });
  });
});
