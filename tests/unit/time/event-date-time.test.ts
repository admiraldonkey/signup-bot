import { describe, expect, it } from "vitest";

import { parseEventDateTime } from "../../../src/time/event-date-time.js";

describe("event local date/time parsing", () => {
  it("resolves a valid local date and time in its named timezone", () => {
    const result = parseEventDateTime("2026-09-24", "20:00", "Europe/London");

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error("Expected date/time parsing to succeed.");
    }

    expect(result.value.toISO()).toBe("2026-09-24T20:00:00.000+01:00");
  });

  it("rejects malformed and impossible calendar values", () => {
    expect(parseEventDateTime("2026-02-30", "20:00", "Europe/London").ok).toBe(
      false,
    );

    /*
     * 01:30 does not exist in London when the clocks move forward.
     */
    expect(parseEventDateTime("2026-03-29", "01:30", "Europe/London").ok).toBe(
      false,
    );
  });

  it("rejects ambiguous local time during the autumn clock change", () => {
    const result = parseEventDateTime("2026-10-25", "01:30", "Europe/London");

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("Expected ambiguous date/time parsing to fail.");
    }

    expect(result.error).toContain("occurs twice");
  });
});
