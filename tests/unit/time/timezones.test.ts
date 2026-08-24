import { describe, expect, it } from "vitest";

import {
  COMMON_TIMEZONES,
  findTimezoneOptions,
  isValidEventTimezone,
} from "../../../src/time/timezones.js";

describe("event timezone handling", () => {
  it("accepts supported IANA timezone identifiers and rejects ambiguous abbreviations", () => {
    expect(isValidEventTimezone("Europe/London")).toBe(true);
    expect(isValidEventTimezone("America/New_York")).toBe(true);
    expect(isValidEventTimezone("Etc/UTC")).toBe(true);

    expect(isValidEventTimezone("BST")).toBe(false);
    expect(isValidEventTimezone("EST")).toBe(false);
    expect(isValidEventTimezone("Not/ARealZone")).toBe(false);
  });

  it("finds common timezones from user-facing search text", () => {
    const pacificMatches = findTimezoneOptions("  PACIFIC  ");
    const britishMatches = findTimezoneOptions("british");
    const blankMatches = findTimezoneOptions("   ");

    expect(pacificMatches.map((option) => option.value)).toContain(
      "America/Los_Angeles",
    );

    expect(britishMatches.map((option) => option.value)).toEqual([
      "Europe/London",
    ]);

    expect(blankMatches).toEqual(COMMON_TIMEZONES);
  });
});
