import type { ChatInputCommandInteraction } from "discord.js";

import { beforeEach, describe, expect, it, vi } from "vitest";

const handlerMocks = vi.hoisted(() => ({
  rolePreset: vi.fn(),

  ping: vi.fn(),

  dbcheck: vi.fn(),

  setup: vi.fn(),

  event: vi.fn(),

  attendance: vi.fn(),

  audit: vi.fn(),
}));

vi.mock("../../../src/commands/role-preset.js", () => ({
  handleRolePresetCommand: handlerMocks.rolePreset,
}));

vi.mock("../../../src/commands/ping.js", () => ({
  handlePingCommand: handlerMocks.ping,
}));

vi.mock("../../../src/commands/dbcheck.js", () => ({
  handleDbCheckCommand: handlerMocks.dbcheck,
}));

vi.mock("../../../src/commands/setup.js", () => ({
  handleSetupCommand: handlerMocks.setup,
}));

vi.mock("../../../src/commands/event.js", () => ({
  handleEventCommand: handlerMocks.event,
}));

vi.mock("../../../src/commands/attendance.js", () => ({
  handleAttendanceCommand: handlerMocks.attendance,
}));

vi.mock("../../../src/commands/audit.js", () => ({
  handleAuditCommand: handlerMocks.audit,
}));

import { handleChatInputCommand } from "../../../src/commands/router.js";

describe("chat-input command router", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    handlerMocks.rolePreset.mockResolvedValue(undefined);
  });

  it("routes /role-preset to its command handler", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      commandName: "role-preset",

      reply,
    } as unknown as ChatInputCommandInteraction;

    await handleChatInputCommand(interaction, 25);

    expect(handlerMocks.rolePreset).toHaveBeenCalledTimes(1);

    expect(handlerMocks.rolePreset).toHaveBeenCalledWith(interaction);

    expect(reply).not.toHaveBeenCalled();
  });
});
