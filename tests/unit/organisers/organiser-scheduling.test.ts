import { describe, expect, it } from "vitest";

import {
  buildOrganiserCoverDeadlineActionKey,
  calculateOrganiserCoverDeadline,
  calculateOrganiserResponseDeadline,
  buildOrganiserEventSafetyActionValues,
  buildOrganiserMissingAtStartActionKey,
} from "../../../src/organisers/organiser-scheduling.js";

describe("organiser scheduling", () => {
  it("calculates confirmation deadlines relative to organiser activation", () => {
    const activatedAt = new Date("2026-09-08T18:00:00.000Z");

    expect(calculateOrganiserResponseDeadline(activatedAt, 70)).toEqual(
      new Date("2026-09-08T19:10:00.000Z"),
    );
  });

  it("calculates the general-cover safety deadline relative to event start", () => {
    const startsAt = new Date("2026-09-08T20:00:00.000Z");

    expect(calculateOrganiserCoverDeadline(startsAt, 15)).toEqual(
      new Date("2026-09-08T19:45:00.000Z"),
    );
  });

  it("allows the cover deadline to be the event start", () => {
    const startsAt = new Date("2026-09-08T20:00:00.000Z");

    expect(calculateOrganiserCoverDeadline(startsAt, 0)).toEqual(startsAt);
  });

  it("builds a stable event-level cover deadline action key", () => {
    expect(buildOrganiserCoverDeadlineActionKey(42)).toBe(
      "organiser_cover_deadline:42",
    );
  });

  it("builds a stable missing-organiser-at-start action key", () => {
    expect(buildOrganiserMissingAtStartActionKey(42)).toBe(
      "organiser_missing_at_start:42",
    );
  });

  it("builds cover-deadline and event-start safety actions from the event schedule", () => {
    const startsAt = new Date("2026-09-08T20:00:00.000Z");

    const updatedAt = new Date("2026-09-08T18:00:00.000Z");

    expect(
      buildOrganiserEventSafetyActionValues({
        eventId: 42,

        startsAt,

        coverMinutesBeforeStart: 15,

        updatedAt,
      }),
    ).toEqual([
      expect.objectContaining({
        eventId: 42,

        actionKey: "organiser_cover_deadline:42",

        dueAt: new Date("2026-09-08T19:45:00.000Z"),

        status: "pending",
      }),

      expect.objectContaining({
        eventId: 42,

        actionKey: "organiser_missing_at_start:42",

        dueAt: startsAt,

        status: "pending",
      }),
    ]);
  });
});
