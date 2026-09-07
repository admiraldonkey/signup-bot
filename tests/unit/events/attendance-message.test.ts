import { describe, expect, it } from "vitest";

import {
  buildAttendanceEmbed,
  EMPTY_ATTENDANCE_COUNTS,
  type AttendanceEventDisplay,
} from "../../../src/events/attendance-message.js";

function createEvent(
  overrides: Partial<AttendanceEventDisplay> = {},
): AttendanceEventDisplay {
  return {
    id: 1,

    name: "Test Event",

    description: null,

    eventTypeName: "Naval",

    audienceName: "Everyone",

    timezone: "Europe/London",

    showDetailedDeadline: true,

    startsAt: new Date("2026-09-08T19:00:00.000Z"),

    organisersEnabled: true,

    organiser: null,

    signupsEnabled: true,

    attendanceClosesAt: new Date("2026-09-08T18:00:00.000Z"),

    status: "open",

    ...overrides,
  };
}

describe("attendance event organiser presentation", () => {
  it("shows an unassigned organiser when organisers are enabled", () => {
    const embed = buildAttendanceEmbed(
      createEvent({
        organisersEnabled: true,

        organiser: null,
      }),

      EMPTY_ATTENDANCE_COUNTS,
    );

    const description = embed.toJSON().description ?? "";

    expect(description).toContain("**Organiser**");

    expect(description).toContain("Not assigned");
  });

  it("omits organiser presentation when organisers are disabled", () => {
    const embed = buildAttendanceEmbed(
      createEvent({
        organisersEnabled: false,

        organiser: null,
      }),

      EMPTY_ATTENDANCE_COUNTS,
    );

    const description = embed.toJSON().description ?? "";

    expect(description).not.toContain("**Organiser**");

    expect(description).not.toContain("Not assigned");
  });
});
