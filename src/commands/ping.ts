import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";

export async function handlePingCommand(
  interaction: ChatInputCommandInteraction,
  gatewayLatency: number,
): Promise<void> {
  await interaction.reply({
    content:
      `Pong. The bot is online with ` + `${gatewayLatency} ms Gateway latency.`,
    flags: MessageFlags.Ephemeral,
  });
}
