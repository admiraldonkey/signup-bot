import { describe, expect, it } from "vitest";

import { resolveRoleRequestGroupLifecycleState } from "../../../src/role-requests/role-request-group-lifecycle.js";

const NOW = new Date("2026-09-09T12:00:00Z");

describe("role-request group lifecycle state", () => {
  it("treats an unpublished group whose opening time is still in the future as planned", () => {
    const state = resolveRoleRequestGroupLifecycleState(
      {
        opensAt: new Date("2026-09-09T13:00:00Z"),

        closesAt: new Date("2026-09-09T14:00:00Z"),

        closedAt: null,

        messageId: null,
      },

      NOW,
    );

    expect(state).toBe("planned");
  });

  it("treats an unpublished group whose opening time has arrived as pending publication", () => {
    const state = resolveRoleRequestGroupLifecycleState(
      {
        opensAt: new Date("2026-09-09T11:00:00Z"),

        closesAt: new Date("2026-09-09T14:00:00Z"),

        closedAt: null,

        messageId: null,
      },

      NOW,
    );

    expect(state).toBe("pending_publication");
  });

  it("treats a linked group inside its request window as open", () => {
    const state = resolveRoleRequestGroupLifecycleState(
      {
        opensAt: new Date("2026-09-09T11:00:00Z"),

        closesAt: new Date("2026-09-09T14:00:00Z"),

        closedAt: null,

        messageId: "988000000000000001",
      },

      NOW,
    );

    expect(state).toBe("open");
  });

  it("treats an explicitly or naturally closed group as closed", () => {
    expect(
      resolveRoleRequestGroupLifecycleState(
        {
          opensAt: new Date("2026-09-09T09:00:00Z"),

          closesAt: new Date("2026-09-09T11:00:00Z"),

          closedAt: null,

          messageId: "988000000000000001",
        },

        NOW,
      ),
    ).toBe("closed");

    expect(
      resolveRoleRequestGroupLifecycleState(
        {
          opensAt: new Date("2026-09-09T11:00:00Z"),

          closesAt: new Date("2026-09-09T14:00:00Z"),

          closedAt: new Date("2026-09-09T11:30:00Z"),

          messageId: "988000000000000001",
        },

        NOW,
      ),
    ).toBe("closed");
  });
});
