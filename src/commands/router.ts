import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";

import { handleDbCheckCommand } from "./dbcheck.js";
import { handlePingCommand } from "./ping.js";
import { handleSetupCommand } from "./setup.js";
import { handleEventCommand } from "./event.js";
import { handleAttendanceCommand } from "./attendance.js";

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

    case "attendance":
      await handleAttendanceCommand(interaction);
      return;

    default:
      await interaction.reply({
        content: "That command is not implemented.",
        flags: MessageFlags.Ephemeral,
      });
  }
}
