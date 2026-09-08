import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";

import { handleAttendanceCommand } from "./attendance.js";

import { handleAuditCommand } from "./audit.js";

import { handleDbCheckCommand } from "./dbcheck.js";

import { handleEventCommand } from "./event.js";

import { handlePingCommand } from "./ping.js";

import { handleRolePresetCommand } from "./role-preset.js";

import { handleSetupCommand } from "./setup.js";

export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  gatewayLatency: number,
): Promise<void> {
  switch (interaction.commandName) {
    case "ping":
      await handlePingCommand(interaction, gatewayLatency);

      return;

    case "dbcheck":
      await handleDbCheckCommand(interaction);

      return;

    case "setup":
      await handleSetupCommand(interaction);

      return;

    case "event":
      await handleEventCommand(interaction);

      return;

    case "role-preset":
      await handleRolePresetCommand(interaction);

      return;

    case "attendance":
      await handleAttendanceCommand(interaction);

      return;

    case "audit":
      await handleAuditCommand(interaction);

      return;

    default:
      await interaction.reply({
        content: "That command is not implemented.",

        flags: MessageFlags.Ephemeral,
      });
  }
}
