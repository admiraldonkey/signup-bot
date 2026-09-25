/// <reference types="node" />

import { execFile } from "node:child_process";
import { cwd, execPath } from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("event recurrence Node runtime compatibility", () => {
  it("loads the recurrence module through the real Node ESM runtime", async () => {
    const script = `
      const recurrence = await import(
        "./src/templates/event-recurrence-rule.ts"
      );

      const result = recurrence.normaliseRecurrenceRule(
        "FREQ=WEEKLY"
      );

      if (!result.ok) {
        throw new Error(
          "Expected the recurrence rule to normalise successfully."
        );
      }

      if (result.recurrenceRule !== "FREQ=WEEKLY") {
        throw new Error(
          \`Unexpected normalised rule: \${result.recurrenceRule}\`
        );
      }
    `;

    const result = await execFileAsync(
      execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: cwd(),
      },
    );

    expect(result.stderr).toBe("");
  });
});
